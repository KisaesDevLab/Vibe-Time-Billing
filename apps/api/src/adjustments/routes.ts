// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Adjustment HTTP surface — Phase 12. Wraps the six allocation methods
// from @vibe/core/adjustment-allocation with auth, approval-threshold
// enforcement (Q27), DB writes, and audit-log emission.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  adjustments,
  adjustmentAllocations,
  billingBatches,
  clients,
  engagements,
  firmSettings,
  timeEntries,
} from '@vibe/db/schema';
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

      const entries: TimeEntryInput[] = rows.map((r) => ({
        id: r.id,
        appUserId: r.appUserId,
        // appUserRole isn't on time_entry — caller assumes 'STAFF' for cascade tier
        // resolution unless the route is given a roles map; until that's wired,
        // we fall back to 'STAFF' which prevents partner-absorbs / cascade from
        // being usable without supplemental data. Surface a 400 if those methods
        // are requested without role data.
        appUserRole: 'STAFF',
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
