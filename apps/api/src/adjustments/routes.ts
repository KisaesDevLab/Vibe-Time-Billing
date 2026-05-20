// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Adjustment HTTP surface — Phase 12. Wraps the six allocation methods
// from @vibe/core/adjustment-allocation with auth, approval-threshold
// enforcement (Q27), DB writes, and audit-log emission.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  adjustments,
  adjustmentAllocations,
  approvalRequests,
  appUsers as appUsersTable,
  billingBatches,
  clients,
  engagements,
  firmSettings,
  roles,
  timeEntries,
  userRoles,
} from '@vibe/db/schema';
import type { AppUserRole } from '@vibe/types';
import {
  allocateCustomWeighted,
  allocateHierarchicalCascade,
  allocatePartnerAbsorbs,
  allocateProRataByHours,
  allocateProRataByValue,
  allocateSpecificEntries,
  type AllocationResult,
  type TimeEntryInput,
} from '@vibe/core';
import { evaluate, type ApprovalRule } from '@vibe/core/approvals';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface AdjustmentRoutesDeps extends RbacDeps {
  db: Database | null;
  // Q4 step-up: any adjustment over the firm's adjustmentApprovalThresholdCents
  // requires fresh TOTP. We apply step-up uniformly on the create endpoint;
  // the threshold check is then a soft signal in the approval workflow.
  requireStepUp: (req: Request, res: Response, next: () => void) => void;
}

const CreateSchema = z
  .object({
    billingBatchId: z.string().uuid(),
    method: z.enum(['RATE', 'TIME', 'FEE']),
    allocationMethod: z.enum([
      'SPECIFIC_ENTRIES',
      'PRO_RATA_BY_VALUE',
      'PRO_RATA_BY_HOURS',
      'PARTNER_ABSORBS',
      'HIERARCHICAL_CASCADE',
      'CUSTOM_WEIGHTED',
    ]),
    totalAmountCents: z.number().int(), // signed; negative = write-down
    reasonCodeId: z.string().uuid(),
    notes: z.string().max(2000).optional(),
    // Method-specific payload
    entrySelections: z
      .array(z.object({ entryId: z.string().uuid(), amountCents: z.number().int() }))
      .optional(),
    cascadeOrder: z.array(z.enum(['PARTNER', 'MANAGER', 'SENIOR', 'STAFF', 'ADMIN'])).optional(),
    weights: z.array(z.object({ appUserId: z.string().uuid(), weight: z.number() })).optional(),
    weightingMode: z.enum(['PERCENT', 'DOLLAR']).optional(),
  })
  .strict();

export function createAdjustmentRouter(deps: AdjustmentRoutesDeps): Router {
  const router = express.Router();

  router.post(
    '/',
    deps.requireStepUp,
    requirePermission(deps, 'adjustment:create'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }

      // Load the billing batch + its time entries (the universe for allocation).
      const [batch] = await deps.db
        .select()
        .from(billingBatches)
        .where(eq(billingBatches.id, parsed.data.billingBatchId))
        .limit(1);
      if (!batch) {
        res.status(404).json({ error: 'billing_batch_not_found' });
        return;
      }
      // Scope by firm via engagement → client.
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, batch.engagementId))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const [client] = await deps.db
        .select()
        .from(clients)
        .where(eq(clients.id, eng.clientId))
        .limit(1);
      if (!client || client.firmId !== session.firmId) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }

      const rows = await deps.db
        .select({
          id: timeEntries.id,
          appUserId: timeEntries.appUserId,
          hours: timeEntries.hours,
          standardAmountCents: timeEntries.standardAmountCents,
        })
        .from(timeEntries)
        .where(eq(timeEntries.billingBatchId, batch.id));
      if (rows.length === 0) {
        res.status(400).json({ error: 'no_time_entries_in_batch' });
        return;
      }

      const userIds = Array.from(new Set(rows.map((r) => r.appUserId)));
      const roleMap = await loadRolesForUsers(deps.db, userIds);
      const entries: TimeEntryInput[] = rows.map((r) => ({
        id: r.id,
        appUserId: r.appUserId,
        appUserRole: roleMap.get(r.appUserId) ?? 'STAFF',
        hours: Number(r.hours),
        standardAmountCents: r.standardAmountCents,
      }));

      let allocation: AllocationResult[];
      try {
        allocation = runAllocation(parsed.data, entries);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'allocation_failed';
        res.status(400).json({ error: 'allocation_failed', detail: message });
        return;
      }

      // Approval threshold (Q27).
      const [settings] = await deps.db
        .select({ thr: firmSettings.adjustmentApprovalThresholdCents })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, session.firmId))
        .limit(1);
      const rules: ApprovalRule[] = [
        {
          id: 'firm-threshold',
          entityType: 'ADJUSTMENT',
          match: 'over_threshold',
          thresholdCents: settings?.thr ?? 100000,
          exemptRoles: [], // role resolution is via RBAC layer, not requesterRole here
          approverResolver: 'partner_in_charge',
        },
      ];
      const decision = evaluate({
        context: {
          entityType: 'ADJUSTMENT',
          entityId: 'pending',
          requesterRole: 'STAFF',
          amountCents: parsed.data.totalAmountCents,
          partnerInChargeId: client.partnerInChargeId,
        },
        rules,
      });

      // Persist atomically.
      const result = await deps.db.transaction(async (tx) => {
        const [adj] = await tx
          .insert(adjustments)
          .values({
            billingBatchId: batch.id,
            method: parsed.data.method,
            allocationMethod: parsed.data.allocationMethod,
            totalAmountCents: parsed.data.totalAmountCents,
            reasonCodeId: parsed.data.reasonCodeId,
            notes: parsed.data.notes ?? '',
            createdById: session.appUserId,
            status: decision.requiresApproval ? 'PENDING_APPROVAL' : 'APPLIED',
          })
          .returning({ id: adjustments.id });
        if (!adj) throw new Error('adjustment insert failed');

        await tx.insert(adjustmentAllocations).values(
          allocation.map((a) => ({
            adjustmentId: adj.id,
            timeEntryId: a.timeEntryId,
            appUserId: a.appUserId,
            originalValueCents: a.originalValueCents,
            adjustedValueCents: a.adjustedValueCents,
            adjustmentAmountCents: a.adjustmentAmountCents,
          })),
        );

        // If approval is required, queue the partner-in-charge.
        if (decision.requiresApproval) {
          await tx.insert(approvalRequests).values({
            entityType: 'ADJUSTMENT',
            entityId: adj.id,
            requesterId: session.appUserId,
            approverId: decision.approverAppUserId ?? client.partnerInChargeId,
            status: 'PENDING',
            comments: parsed.data.notes ?? null,
          });
        }

        return adj.id;
      });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'adjustment',
        entityId: result,
        actorAppUserId: session.appUserId,
        after: {
          method: parsed.data.method,
          allocationMethod: parsed.data.allocationMethod,
          totalAmountCents: parsed.data.totalAmountCents,
          requiresApproval: decision.requiresApproval,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.status(201).json({
        id: result,
        requiresApproval: decision.requiresApproval,
        approverAppUserId: decision.approverAppUserId,
        allocationCount: allocation.length,
      });
    },
  );

  // Preview: run the allocation but don't persist. Used by the
  // adjustment dialog to show the per-timekeeper cascade preview.
  router.post(
    '/preview',
    requirePermission(deps, 'adjustment:create'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.json({ allocations: [], total: parsed.data.totalAmountCents });
        return;
      }
      const rows = await deps.db
        .select({
          id: timeEntries.id,
          appUserId: timeEntries.appUserId,
          hours: timeEntries.hours,
          standardAmountCents: timeEntries.standardAmountCents,
        })
        .from(timeEntries)
        .where(eq(timeEntries.billingBatchId, parsed.data.billingBatchId));
      const userIds = Array.from(new Set(rows.map((r) => r.appUserId)));
      const userRows =
        userIds.length === 0
          ? []
          : await deps.db
              .select({ id: appUsersTable.id, fullName: appUsersTable.fullName })
              .from(appUsersTable)
              .where(inArray(appUsersTable.id, userIds));
      const userName = new Map(userRows.map((u) => [u.id, u.fullName]));
      const roleMap = await loadRolesForUsers(deps.db, userIds);

      const entries: TimeEntryInput[] = rows.map((r) => ({
        id: r.id,
        appUserId: r.appUserId,
        appUserRole: roleMap.get(r.appUserId) ?? 'STAFF',
        hours: Number(r.hours),
        standardAmountCents: r.standardAmountCents,
      }));
      let allocation: AllocationResult[];
      try {
        allocation = runAllocation(parsed.data, entries);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'allocation_failed';
        res.status(400).json({ error: 'allocation_failed', detail: message });
        return;
      }
      const decorated = allocation.map((a) => ({
        ...a,
        appUserName: userName.get(a.appUserId) ?? null,
      }));
      res.json({ allocations: decorated, total: parsed.data.totalAmountCents });
    },
  );

  router.get(
    '/:id/allocations',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ allocations: [] });
        return;
      }
      const rows = await deps.db
        .select()
        .from(adjustmentAllocations)
        .where(eq(adjustmentAllocations.adjustmentId, req.params['id']!));
      res.json({ allocations: rows });
    },
  );

  router.get(
    '/',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const batchId = typeof req.query['batchId'] === 'string' ? req.query['batchId'] : null;
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      const engagementId =
        typeof req.query['engagementId'] === 'string' ? req.query['engagementId'] : null;
      const conds = [] as ReturnType<typeof eq>[];
      if (batchId) conds.push(eq(adjustments.billingBatchId, batchId));
      if (engagementId) {
        // Filter batches in that engagement.
        const batchRows = await deps.db
          .select({ id: billingBatches.id })
          .from(billingBatches)
          .where(eq(billingBatches.engagementId, engagementId));
        const batchIds = batchRows.map((b) => b.id);
        if (batchIds.length === 0) {
          res.json({ items: [] });
          return;
        }
        conds.push(inArray(adjustments.billingBatchId, batchIds));
      }
      const allowed = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'APPLIED', 'REVERSED'];
      if (status && allowed.includes(status)) {
        conds.push(
          eq(
            adjustments.status,
            status as
              | 'DRAFT'
              | 'PENDING_APPROVAL'
              | 'APPROVED'
              | 'REJECTED'
              | 'APPLIED'
              | 'REVERSED',
          ),
        );
      }
      const builder = deps.db.select().from(adjustments);
      const items = await (conds.length === 0
        ? builder.orderBy(desc(adjustments.createdAt)).limit(500)
        : builder
            .where(and(...conds))
            .orderBy(desc(adjustments.createdAt))
            .limit(500));
      res.json({ items });
    },
  );

  router.post(
    '/:id/reverse',
    requirePermission(deps, 'adjustment:reverse'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [adj] = await deps.db
        .select()
        .from(adjustments)
        .where(eq(adjustments.id, req.params['id']!))
        .limit(1);
      if (!adj) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (adj.status === 'REVERSED') {
        res.status(409).json({ error: 'already_reversed' });
        return;
      }
      if (adj.status !== 'APPLIED' && adj.status !== 'APPROVED') {
        res.status(409).json({ error: 'not_reversible', status: adj.status });
        return;
      }
      await deps.db
        .update(adjustments)
        .set({
          status: 'REVERSED',
          reversedAt: new Date(),
          reversedById: session.appUserId,
        })
        .where(eq(adjustments.id, adj.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'adjustment',
        entityId: adj.id,
        actorAppUserId: session.appUserId,
        after: { status: 'REVERSED' },
        ip: (
          req.headers['x-forwarded-for']?.toString().split(',')[0] ??
          req.ip ??
          '0.0.0.0'
        ).trim(),
        userAgent: req.header('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}

function runAllocation(
  input: z.infer<typeof CreateSchema>,
  entries: TimeEntryInput[],
): AllocationResult[] {
  switch (input.allocationMethod) {
    case 'SPECIFIC_ENTRIES':
      if (!input.entrySelections) throw new Error('entrySelections required');
      return allocateSpecificEntries({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
        entrySelections: input.entrySelections,
      });
    case 'PRO_RATA_BY_VALUE':
      return allocateProRataByValue({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
      });
    case 'PRO_RATA_BY_HOURS':
      return allocateProRataByHours({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
      });
    case 'PARTNER_ABSORBS':
      return allocatePartnerAbsorbs({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
      });
    case 'HIERARCHICAL_CASCADE':
      if (!input.cascadeOrder) throw new Error('cascadeOrder required');
      return allocateHierarchicalCascade({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
        cascadeOrder: input.cascadeOrder,
      });
    case 'CUSTOM_WEIGHTED':
      if (!input.weights || !input.weightingMode) {
        throw new Error('weights and weightingMode required');
      }
      return allocateCustomWeighted({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
        weightingMode: input.weightingMode,
        weights: input.weights,
      });
  }
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

const KNOWN_ROLES: AppUserRole[] = ['PARTNER', 'MANAGER', 'SENIOR', 'STAFF', 'ADMIN'];

async function loadRolesForUsers(
  db: Database,
  userIds: string[],
): Promise<Map<string, AppUserRole>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: userRoles.appUserId, slug: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(inArray(userRoles.appUserId, userIds));
  const out = new Map<string, AppUserRole>();
  for (const r of rows) {
    const upper = r.slug.toUpperCase() as AppUserRole;
    if (KNOWN_ROLES.includes(upper)) out.set(r.userId, upper);
  }
  return out;
}
