// SPDX-License-Identifier: Elastic-2.0
//
// Tax-season rollforward API. Create a batch (engagement preview), review/edit
// engagement + appointment candidates, then commit. Gated by engagement:write
// (engagement:read for the read-only GET).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  rollforwardAppointmentCandidates,
  rollforwardBatches,
  rollforwardEngagementCandidates,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { buildAppointmentCandidates, recomputeConflicts } from './appointments';
import { commitRollforwardBatch, createRollforwardBatch } from './service';

export interface RollforwardRoutesDeps extends RbacDeps {
  db: Database | null;
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CreateSchema = z.object({
  staffId: z.string().uuid(),
  sourceStart: DATE,
  sourceEnd: DATE,
  targetYear: z.number().int().min(2000).max(2100),
  mode: z.enum(['DEADLINE', 'ISO_WEEK']).default('DEADLINE'),
  engagementIds: z.array(z.string().uuid()).optional(),
  includeInactive: z.boolean().optional(),
});

const BulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  action: z.enum(['APPROVE', 'UNAPPROVE', 'SKIP']),
});

const statusFor = (action: 'APPROVE' | 'UNAPPROVE' | 'SKIP'): string =>
  action === 'APPROVE' ? 'APPROVED' : action === 'SKIP' ? 'SKIPPED' : 'PENDING';

export function createRollforwardRouter(deps: RollforwardRoutesDeps): Router {
  const router = express.Router();

  // Confirm the batch belongs to the caller's firm (and isn't committed, for mutations).
  async function loadBatch(db: Database, id: string, firmId: string) {
    const [b] = await db
      .select()
      .from(rollforwardBatches)
      .where(and(eq(rollforwardBatches.id, id), eq(rollforwardBatches.firmId, firmId)))
      .limit(1);
    return b ?? null;
  }

  async function engagementCandidates(db: Database, batchId: string) {
    return db
      .select()
      .from(rollforwardEngagementCandidates)
      .where(eq(rollforwardEngagementCandidates.batchId, batchId));
  }
  async function appointmentCandidates(db: Database, batchId: string) {
    return db
      .select()
      .from(rollforwardAppointmentCandidates)
      .where(eq(rollforwardAppointmentCandidates.batchId, batchId));
  }

  // Create a batch + engagement preview.
  router.post(
    '/',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success)
        return void res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      const { firmId, appUserId } = req.staffSession!;
      const result = await createRollforwardBatch(deps.db, {
        firmId,
        staffId: parsed.data.staffId,
        sourceStart: parsed.data.sourceStart,
        sourceEnd: parsed.data.sourceEnd,
        targetYear: parsed.data.targetYear,
        mode: parsed.data.mode,
        createdByAppUserId: appUserId,
        engagementIds: parsed.data.engagementIds,
        includeInactive: parsed.data.includeInactive,
      });
      res.json({
        batchId: result.batchId,
        engagementCount: result.engagementCount,
        engagementCandidates: await engagementCandidates(deps.db, result.batchId),
      });
    },
  );

  router.get(
    '/:id',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const batch = await loadBatch(deps.db, req.params['id']!, req.staffSession!.firmId);
      if (!batch) return void res.status(404).json({ error: 'not_found' });
      res.json({
        batch,
        engagementCandidates: await engagementCandidates(deps.db, batch.id),
        appointmentCandidates: await appointmentCandidates(deps.db, batch.id),
      });
    },
  );

  router.patch(
    '/:id/engagements/:cid',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const batch = await loadBatch(deps.db, req.params['id']!, req.staffSession!.firmId);
      if (!batch || batch.status === 'COMMITTED')
        return void res.status(404).json({ error: 'not_found_or_committed' });
      const Body = z.object({
        suggestedDueDate: DATE.nullable().optional(),
        suggestedDropoffDate: DATE.nullable().optional(),
        suggestedFeeCents: z.number().int().min(0).nullable().optional(),
      });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      await deps.db
        .update(rollforwardEngagementCandidates)
        .set(parsed.data)
        .where(
          and(
            eq(rollforwardEngagementCandidates.id, req.params['cid']!),
            eq(rollforwardEngagementCandidates.batchId, batch.id),
          ),
        );
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/engagements/bulk',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const batch = await loadBatch(deps.db, req.params['id']!, req.staffSession!.firmId);
      if (!batch || batch.status === 'COMMITTED')
        return void res.status(404).json({ error: 'not_found_or_committed' });
      const parsed = BulkSchema.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      for (const id of parsed.data.ids) {
        await deps.db
          .update(rollforwardEngagementCandidates)
          .set({ status: statusFor(parsed.data.action) })
          .where(
            and(
              eq(rollforwardEngagementCandidates.id, id),
              eq(rollforwardEngagementCandidates.batchId, batch.id),
            ),
          );
      }
      res.json({ ok: true });
    },
  );

  // Build appointment candidates for the currently-approved engagements.
  router.post(
    '/:id/appointments/preview',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const batch = await loadBatch(deps.db, req.params['id']!, req.staffSession!.firmId);
      if (!batch || batch.status === 'COMMITTED')
        return void res.status(404).json({ error: 'not_found_or_committed' });
      const count = await buildAppointmentCandidates(deps.db, {
        batchId: batch.id,
        firmId: batch.firmId,
        targetYear: batch.targetYear,
        mode: batch.mappingMode as 'DEADLINE' | 'ISO_WEEK',
        allowAppointmentOnly: Boolean(
          (req.body as { allowAppointmentOnly?: boolean })?.allowAppointmentOnly,
        ),
      });
      res.json({ count, appointmentCandidates: await appointmentCandidates(deps.db, batch.id) });
    },
  );

  router.patch(
    '/:id/appointments/:cid',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const batch = await loadBatch(deps.db, req.params['id']!, req.staffSession!.firmId);
      if (!batch || batch.status === 'COMMITTED')
        return void res.status(404).json({ error: 'not_found_or_committed' });
      const Body = z.object({ suggestedStartsAt: z.string().datetime() });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      await deps.db
        .update(rollforwardAppointmentCandidates)
        .set({ suggestedStartsAt: new Date(parsed.data.suggestedStartsAt) })
        .where(
          and(
            eq(rollforwardAppointmentCandidates.id, req.params['cid']!),
            eq(rollforwardAppointmentCandidates.batchId, batch.id),
          ),
        );
      await recomputeConflicts(deps.db, batch.id);
      res.json({ appointmentCandidates: await appointmentCandidates(deps.db, batch.id) });
    },
  );

  router.post(
    '/:id/appointments/bulk',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const batch = await loadBatch(deps.db, req.params['id']!, req.staffSession!.firmId);
      if (!batch || batch.status === 'COMMITTED')
        return void res.status(404).json({ error: 'not_found_or_committed' });
      const parsed = BulkSchema.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      for (const id of parsed.data.ids) {
        await deps.db
          .update(rollforwardAppointmentCandidates)
          .set({ status: statusFor(parsed.data.action) })
          .where(
            and(
              eq(rollforwardAppointmentCandidates.id, id),
              eq(rollforwardAppointmentCandidates.batchId, batch.id),
            ),
          );
      }
      await recomputeConflicts(deps.db, batch.id);
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/commit',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const { firmId, appUserId } = req.staffSession!;
      const batch = await loadBatch(deps.db, req.params['id']!, firmId);
      if (!batch) return void res.status(404).json({ error: 'not_found' });
      const result = await commitRollforwardBatch(deps.db, {
        batchId: batch.id,
        firmId,
        actorAppUserId: appUserId,
        allowAppointmentOnly: Boolean(
          (req.body as { allowAppointmentOnly?: boolean })?.allowAppointmentOnly,
        ),
      });
      if (!result.alreadyCommitted) {
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'rollforward_batch',
          entityId: batch.id,
          actorAppUserId: appUserId,
          after: {
            engagementsCreated: result.engagementsCreated,
            appointmentsCreated: result.appointmentsCreated,
            mapping: result.mapping,
          },
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        }).catch(() => undefined);
      }
      res.json(result);
    },
  );

  return router;
}
