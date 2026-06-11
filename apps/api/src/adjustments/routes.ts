// SPDX-License-Identifier: Elastic-2.0
//
// Adjustment HTTP surface — Phase 12. Wraps the six allocation methods
// from @vibe/core/adjustment-allocation with auth, approval-threshold
// enforcement (Q27), DB writes, and audit-log emission.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql as drz } from 'drizzle-orm';

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
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface AdjustmentRoutesDeps extends RbacDeps {
  db: Database | null;
  // Q4 step-up: any adjustment over the firm's adjustmentApprovalThresholdCents
  // requires fresh TOTP. We apply step-up uniformly on the create endpoint;
  // the threshold check is then a soft signal in the approval workflow.
  requireStepUp: (req: Request, res: Response, next: () => void) => void;
  // Phase 18 #8 — optional email dispatcher. When provided, the route
  // notifies the assigned approver post-commit. No-op in dev/test if
  // omitted; the audit emit still fires either way.
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  staffBaseUrl?: string;
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
  addUuidIdGuard(router);

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
        let assignedApproverId: string | null = null;
        if (decision.requiresApproval) {
          assignedApproverId = decision.approverAppUserId ?? client.partnerInChargeId ?? null;
          // Phase 18 #13 — set dueAt = now + 48h as the default SLA window.
          // (Per-rule slaHours overrides this when the approval rule
          // engine is plugged in past the firm-threshold stub.)
          const dueAt = new Date(Date.now() + 48 * 3600 * 1000);
          await tx.insert(approvalRequests).values({
            entityType: 'ADJUSTMENT',
            entityId: adj.id,
            requesterId: session.appUserId,
            approverId: assignedApproverId,
            status: 'PENDING',
            comments: parsed.data.notes ?? null,
            dueAt,
          });
        }

        return { adjId: adj.id, assignedApproverId };
      });
      const adjId = result.adjId;
      const assignedApproverId = result.assignedApproverId;

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'adjustment',
        entityId: adjId,
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

      // Phase 18 #8 — notify the assigned approver.
      if (assignedApproverId && deps.sendEmail) {
        try {
          const [approver] = await deps.db
            .select({
              email: appUsersTable.email,
              fullName: appUsersTable.fullName,
            })
            .from(appUsersTable)
            .where(eq(appUsersTable.id, assignedApproverId))
            .limit(1);
          if (approver?.email) {
            const dollars = (parsed.data.totalAmountCents / 100).toLocaleString('en-US', {
              style: 'currency',
              currency: 'USD',
            });
            const sign = parsed.data.totalAmountCents < 0 ? 'write-down' : 'write-up';
            const link = deps.staffBaseUrl
              ? `${deps.staffBaseUrl}/approvals?entityId=${adjId}`
              : `/approvals?entityId=${adjId}`;
            await deps.sendEmail({
              to: approver.email,
              subject: `Approval needed: ${sign} ${dollars} on engagement ${eng.name}`,
              body: [
                `Hi ${approver.fullName ?? 'there'},`,
                ``,
                `An adjustment requires your approval:`,
                `  Engagement: ${eng.name}`,
                `  Amount: ${dollars} (${sign})`,
                `  Method: ${parsed.data.method} / ${parsed.data.allocationMethod}`,
                parsed.data.notes ? `  Notes: ${parsed.data.notes}` : null,
                ``,
                `Open the approvals queue: ${link}`,
              ]
                .filter(Boolean)
                .join('\n'),
            });
          }
        } catch (err) {
          logger.warn({ err, approverId: assignedApproverId }, 'approval assignment email failed');
        }
      }

      res.status(201).json({
        id: adjId,
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
      const batchId = uuidQueryParam(req.query['batchId']);
      if (batchId === 'invalid') {
        res.status(400).json({ error: 'invalid_batch_id' });
        return;
      }
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      const engagementId = uuidQueryParam(req.query['engagementId']);
      if (engagementId === 'invalid') {
        res.status(400).json({ error: 'invalid_engagement_id' });
        return;
      }
      const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
      const conds = [] as Array<ReturnType<typeof eq> | ReturnType<typeof drz>>;
      if (batchId) conds.push(eq(adjustments.billingBatchId, batchId));
      // Phase 12 #26 — free-text search across notes and id prefix.
      if (q) {
        conds.push(
          drz`(${adjustments.notes} ILIKE ${'%' + q + '%'} OR ${adjustments.id}::text ILIKE ${q + '%'})`,
        );
      }
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

  router.patch(
    '/:id',
    requirePermission(deps, 'adjustment:create'),
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
      if (adj.status !== 'DRAFT' && adj.status !== 'PENDING_APPROVAL') {
        res.status(409).json({ error: 'not_editable', status: adj.status });
        return;
      }
      const body = req.body as { notes?: unknown };
      const patch: Record<string, unknown> = {};
      if (typeof body.notes === 'string') patch['notes'] = body.notes.slice(0, 2000);
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db.update(adjustments).set(patch).where(eq(adjustments.id, adj.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'adjustment',
        entityId: adj.id,
        actorAppUserId: session.appUserId,
        after: patch,
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

  router.get(
    '/count-by-status',
    requirePermission(deps, 'billing_batch:read'),
    async (_req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ counts: {} });
        return;
      }
      const { sql: drz } = await import('drizzle-orm');
      const rows = await deps.db
        .select({ status: adjustments.status, c: drz<number>`COUNT(*)`.as('c') })
        .from(adjustments)
        .groupBy(adjustments.status);
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.status] = Number(r.c);
      res.json({ counts });
    },
  );

  router.get(
    '/by-creator/:userId',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(adjustments)
        .where(eq(adjustments.createdById, req.params['userId']!))
        .orderBy(desc(adjustments.createdAt))
        .limit(500);
      res.json({ items });
    },
  );

  router.get(
    '/by-approver/:userId',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(adjustments)
        .where(eq(adjustments.approverId, req.params['userId']!))
        .orderBy(desc(adjustments.approvedAt))
        .limit(500);
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

  router.get(
    '/export.csv',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.send('id,kind,method,status,totalCents,createdAt\n');
        return;
      }
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      const cIds = firmClients.map((c) => c.id);
      if (cIds.length === 0) {
        res.send('id,kind,method,status,totalCents,createdAt\n');
        return;
      }
      const engs = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(inArray(engagements.clientId, cIds));
      const engIds = engs.map((e) => e.id);
      const batches = engIds.length
        ? await deps.db
            .select({ id: billingBatches.id, engagementId: billingBatches.engagementId })
            .from(billingBatches)
            .where(inArray(billingBatches.engagementId, engIds))
        : [];
      const batchIds = batches.map((b) => b.id);
      const engByBatch = new Map(batches.map((b) => [b.id, b.engagementId]));
      const items = batchIds.length
        ? await deps.db
            .select()
            .from(adjustments)
            .where(inArray(adjustments.billingBatchId, batchIds))
            .limit(20000)
        : [];
      const header = [
        'id',
        'engagementId',
        'method',
        'allocationMethod',
        'status',
        'totalAmountCents',
        'reasonCodeId',
        'createdAt',
      ];
      const lines = [header.join(',')];
      for (const a of items) {
        lines.push(
          [
            a.id,
            engByBatch.get(a.billingBatchId) ?? '',
            a.method,
            a.allocationMethod,
            a.status,
            String(a.totalAmountCents ?? 0),
            a.reasonCodeId ?? '',
            a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt,
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="adjustments-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(lines.join('\n') + '\n');
    },
  );

  // -----------------------------------------------------------------
  // Bulk-across-engagements preview (Phase 12 #21). Given a list of
  // billing-batch IDs + a target realization percentage, compute the
  // suggested per-batch write-down totals — no writes. Caller can then
  // POST /adjustments per batch with the suggested amount.
  // -----------------------------------------------------------------
  router.post(
    '/bulk-preview',
    requirePermission(deps, 'adjustment:create'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const body = req.body as {
        billingBatchIds?: unknown;
        targetRealizationPct?: unknown;
      };
      if (!Array.isArray(body.billingBatchIds) || body.billingBatchIds.length === 0) {
        res.status(400).json({ error: 'billingBatchIds_required' });
        return;
      }
      const target =
        typeof body.targetRealizationPct === 'number' ? body.targetRealizationPct : NaN;
      if (!Number.isFinite(target) || target < 0 || target > 2) {
        res.status(400).json({ error: 'targetRealizationPct_must_be_0_to_2' });
        return;
      }
      const batchIds = body.billingBatchIds.filter((b): b is string => typeof b === 'string');
      // Scope-check: every batch must belong to the firm.
      const scoped = await deps.db
        .select({ id: billingBatches.id, engagementId: billingBatches.engagementId })
        .from(billingBatches)
        .innerJoin(engagements, eq(engagements.id, billingBatches.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(inArray(billingBatches.id, batchIds), eq(clients.firmId, session.firmId)));
      const allowed = new Set(scoped.map((s) => s.id));
      const items: {
        billingBatchId: string;
        engagementId: string | null;
        currentWipCents: number;
        suggestedWriteDownCents: number;
      }[] = [];
      for (const bid of batchIds) {
        if (!allowed.has(bid)) continue;
        const [agg] = await deps.db
          .select({ total: drz<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)` })
          .from(timeEntries)
          .where(eq(timeEntries.billingBatchId, bid));
        const wip = Number(agg?.total ?? 0);
        const targetCents = Math.round(wip * target);
        items.push({
          billingBatchId: bid,
          engagementId: scoped.find((s) => s.id === bid)?.engagementId ?? null,
          currentWipCents: wip,
          suggestedWriteDownCents: targetCents - wip,
        });
      }
      const totalWip = items.reduce((a, b) => a + b.currentWipCents, 0);
      const totalAdjustment = items.reduce((a, b) => a + b.suggestedWriteDownCents, 0);
      res.json({
        targetRealizationPct: target,
        batches: items,
        totals: { wipCents: totalWip, suggestedAdjustmentCents: totalAdjustment },
      });
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
