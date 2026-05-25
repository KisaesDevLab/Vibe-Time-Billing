// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP12 — Appointments staff API.
//
// Mounted at /api/staff/appointments. Endpoints:
//   GET    /                       — list, filter by status/from/to/clientId
//   GET    /:id                    — detail
//   POST   /                       — create (CREATE audit)
//   PATCH  /:id                    — update mutable fields (UPDATE audit)
//   POST   /:id/cancel             — soft-cancel with reason
//   POST   /:id/complete           — mark COMPLETED (after the meeting)
//
// State machine:
//   SCHEDULED → CANCELLED  (cancel; sets cancelled_at, reason, by_id)
//   SCHEDULED → COMPLETED  (complete; one-way)
//   COMPLETED / CANCELLED  → terminal (firm creates a new appointment
//                                       to reschedule)

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { appointments, clients, engagements } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface AppointmentRoutesDeps extends RbacDeps {
  db: Database | null;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/;

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  engagementId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(240),
  description: z.string().max(4000).optional(),
  startsAt: z.string().regex(ISO_RE),
  endsAt: z.string().regex(ISO_RE),
  location: z.enum(['VIDEO', 'PHONE', 'IN_PERSON']).optional(),
  locationDetail: z.string().max(1000).optional(),
  leadAppUserId: z.string().uuid().nullable().optional(),
});

const PatchSchema = z.object({
  title: z.string().min(1).max(240).optional(),
  description: z.string().max(4000).nullable().optional(),
  startsAt: z.string().regex(ISO_RE).optional(),
  endsAt: z.string().regex(ISO_RE).optional(),
  location: z.enum(['VIDEO', 'PHONE', 'IN_PERSON']).optional(),
  locationDetail: z.string().max(1000).nullable().optional(),
  leadAppUserId: z.string().uuid().nullable().optional(),
});

const CancelSchema = z.object({ reason: z.string().min(1).max(400) });

export function createAppointmentRouter(deps: AppointmentRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get(
    '/',
    requirePermission(deps, 'appointment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const conds = [eq(appointments.firmId, session.firmId)];
      const clientFilter = uuidQueryParam(req.query['clientId']);
      if (clientFilter && clientFilter !== 'invalid') {
        conds.push(eq(appointments.clientId, clientFilter));
      }
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      if (status === 'SCHEDULED' || status === 'COMPLETED' || status === 'CANCELLED') {
        conds.push(eq(appointments.status, status));
      }
      const from = typeof req.query['from'] === 'string' ? req.query['from'] : null;
      if (from && ISO_RE.test(from)) {
        conds.push(gte(appointments.startsAt, new Date(from)));
      }
      const to = typeof req.query['to'] === 'string' ? req.query['to'] : null;
      if (to && ISO_RE.test(to)) {
        conds.push(lte(appointments.startsAt, new Date(to)));
      }
      const items = await deps.db
        .select()
        .from(appointments)
        .where(and(...conds))
        .orderBy(desc(appointments.startsAt))
        .limit(500);
      res.json({ items });
    },
  );

  router.get(
    '/:id',
    requirePermission(deps, 'appointment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(appointments)
        .where(and(eq(appointments.id, req.params['id']!), eq(appointments.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ appointment: row });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'appointment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (new Date(parsed.data.endsAt).getTime() <= new Date(parsed.data.startsAt).getTime()) {
        res.status(400).json({ error: 'ends_before_starts' });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      if (parsed.data.engagementId) {
        const [eng] = await deps.db
          .select({ id: engagements.id })
          .from(engagements)
          .where(
            and(
              eq(engagements.id, parsed.data.engagementId),
              eq(engagements.clientId, parsed.data.clientId),
            ),
          )
          .limit(1);
        if (!eng) {
          res.status(400).json({ error: 'engagement_not_in_client' });
          return;
        }
      }
      const [row] = await deps.db
        .insert(appointments)
        .values({
          firmId: session.firmId,
          clientId: parsed.data.clientId,
          engagementId: parsed.data.engagementId ?? null,
          title: parsed.data.title,
          description: parsed.data.description ?? null,
          startsAt: new Date(parsed.data.startsAt),
          endsAt: new Date(parsed.data.endsAt),
          location: parsed.data.location ?? 'VIDEO',
          locationDetail: parsed.data.locationDetail ?? null,
          leadAppUserId: parsed.data.leadAppUserId ?? session.appUserId,
          status: 'SCHEDULED',
          createdById: session.appUserId,
        })
        .returning({ id: appointments.id });
      if (!row) throw new Error('appointment_insert_failed');
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'appointment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: {
          clientId: parsed.data.clientId,
          title: parsed.data.title,
          startsAt: parsed.data.startsAt,
          endsAt: parsed.data.endsAt,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row.id });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'appointment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(appointments)
        .where(and(eq(appointments.id, req.params['id']!), eq(appointments.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.status !== 'SCHEDULED') {
        res.status(409).json({ error: 'not_editable', currentStatus: prior.status });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.title != null) patch['title'] = parsed.data.title;
      if (parsed.data.description !== undefined) patch['description'] = parsed.data.description;
      if (parsed.data.startsAt != null) patch['startsAt'] = new Date(parsed.data.startsAt);
      if (parsed.data.endsAt != null) patch['endsAt'] = new Date(parsed.data.endsAt);
      if (parsed.data.location != null) patch['location'] = parsed.data.location;
      if (parsed.data.locationDetail !== undefined) {
        patch['locationDetail'] = parsed.data.locationDetail;
      }
      if (parsed.data.leadAppUserId !== undefined) {
        patch['leadAppUserId'] = parsed.data.leadAppUserId;
      }
      // Re-check time order if either bound changed.
      const nextStart = patch['startsAt'] instanceof Date ? patch['startsAt'] : prior.startsAt;
      const nextEnd = patch['endsAt'] instanceof Date ? patch['endsAt'] : prior.endsAt;
      if (nextEnd.getTime() <= nextStart.getTime()) {
        res.status(400).json({ error: 'ends_before_starts' });
        return;
      }
      await deps.db.update(appointments).set(patch).where(eq(appointments.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'appointment',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: prior,
        after: patch,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/cancel',
    requirePermission(deps, 'appointment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = CancelSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(appointments)
        .where(and(eq(appointments.id, req.params['id']!), eq(appointments.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.status !== 'SCHEDULED') {
        res.status(409).json({ error: 'not_cancellable', currentStatus: row.status });
        return;
      }
      const now = new Date();
      await deps.db
        .update(appointments)
        .set({
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledReason: parsed.data.reason,
          cancelledById: session.appUserId,
          updatedAt: now,
        })
        .where(eq(appointments.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'appointment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { status: 'SCHEDULED' },
        after: { status: 'CANCELLED', reason: parsed.data.reason },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/complete',
    requirePermission(deps, 'appointment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(appointments)
        .where(and(eq(appointments.id, req.params['id']!), eq(appointments.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.status !== 'SCHEDULED') {
        res.status(409).json({ error: 'not_completable', currentStatus: row.status });
        return;
      }
      await deps.db
        .update(appointments)
        .set({ status: 'COMPLETED', updatedAt: new Date() })
        .where(eq(appointments.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'appointment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { status: 'SCHEDULED' },
        after: { status: 'COMPLETED' },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}
