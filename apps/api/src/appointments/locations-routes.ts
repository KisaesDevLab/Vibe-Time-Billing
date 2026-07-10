// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0144 — Appointment Locations admin API. Mounted at
// /api/staff/admin/appointment-locations. The firm-managed list of reusable
// appointment locations (name + meeting type + detail), selectable at
// booking time and attachable to availability windows. A location in use
// cannot be hard-deleted — only deactivated.
//
//   GET    /            — list (all, active + inactive), sorted
//   POST   /            — create
//   PATCH  /:id         — edit fields / activate / deactivate
//   DELETE /:id         — hard-delete ONLY when unused; else 409
//   POST   /reorder     — bulk set sort_order

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { appointmentLocationOptions, appointments, staffAvailability } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';

export interface AppointmentLocationRoutesDeps extends RbacDeps {
  db: Database | null;
}

const LOCATION_TYPES = ['VIDEO', 'PHONE', 'IN_PERSON'] as const;

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  locationType: z.enum(LOCATION_TYPES),
  detail: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  locationType: z.enum(LOCATION_TYPES).optional(),
  detail: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const ReorderSchema = z.object({
  order: z.array(z.string().uuid()).min(1).max(200),
});

export function createAppointmentLocationRouter(deps: AppointmentLocationRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get(
    '/',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(appointmentLocationOptions)
        .where(eq(appointmentLocationOptions.firmId, firmId))
        .orderBy(asc(appointmentLocationOptions.sortOrder), asc(appointmentLocationOptions.name));
      res.json({ items });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .insert(appointmentLocationOptions)
        .values({
          firmId,
          name: parsed.data.name,
          locationType: parsed.data.locationType,
          detail: parsed.data.detail ?? null,
          isActive: parsed.data.isActive ?? true,
          sortOrder: parsed.data.sortOrder ?? 0,
        })
        .returning({ id: appointmentLocationOptions.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'appointment_location_option',
        entityId: row?.id,
        actorAppUserId: req.staffSession!.appUserId,
        after: parsed.data,
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [existing] = await deps.db
        .select()
        .from(appointmentLocationOptions)
        .where(
          and(
            eq(appointmentLocationOptions.id, req.params['id']!),
            eq(appointmentLocationOptions.firmId, firmId),
          ),
        )
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.name != null) patch['name'] = parsed.data.name;
      if (parsed.data.locationType != null) patch['locationType'] = parsed.data.locationType;
      if (parsed.data.detail !== undefined) patch['detail'] = parsed.data.detail;
      if (parsed.data.isActive != null) patch['isActive'] = parsed.data.isActive;
      if (parsed.data.sortOrder != null) patch['sortOrder'] = parsed.data.sortOrder;
      await deps.db
        .update(appointmentLocationOptions)
        .set(patch)
        .where(eq(appointmentLocationOptions.id, existing.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'appointment_location_option',
        entityId: existing.id,
        actorAppUserId: req.staffSession!.appUserId,
        before: existing,
        after: patch,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [existing] = await deps.db
        .select()
        .from(appointmentLocationOptions)
        .where(
          and(
            eq(appointmentLocationOptions.id, req.params['id']!),
            eq(appointmentLocationOptions.firmId, firmId),
          ),
        )
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // In use by an appointment or an availability window → deactivate, not delete.
      const [used] = await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(appointments)
        .where(eq(appointments.locationOptionId, existing.id));
      const [usedAvail] = await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(staffAvailability)
        .where(eq(staffAvailability.locationOptionId, existing.id));
      if ((used?.n ?? 0) > 0 || (usedAvail?.n ?? 0) > 0) {
        res.status(409).json({ error: 'location_in_use', hint: 'deactivate' });
        return;
      }
      await deps.db
        .delete(appointmentLocationOptions)
        .where(eq(appointmentLocationOptions.id, existing.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'appointment_location_option',
        entityId: existing.id,
        actorAppUserId: req.staffSession!.appUserId,
        before: existing,
      }).catch(() => undefined);
      res.status(204).end();
    },
  );

  router.post(
    '/reorder',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = ReorderSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const db = deps.db;
      await db.transaction(async (tx) => {
        for (let i = 0; i < parsed.data.order.length; i++) {
          await tx
            .update(appointmentLocationOptions)
            .set({ sortOrder: i, updatedAt: new Date() })
            .where(
              and(
                eq(appointmentLocationOptions.id, parsed.data.order[i]!),
                eq(appointmentLocationOptions.firmId, firmId),
              ),
            );
        }
      });
      res.json({ ok: true });
    },
  );

  return router;
}
