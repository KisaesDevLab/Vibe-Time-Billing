// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-1 — Appointment Types admin API. Mounted at
// /api/staff/admin/appointment-types. The firm-managed library of
// bookable meeting types (name + default duration + default location +
// color). Types in use cannot be hard-deleted — only deactivated.
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
import { appointmentTypes, appointments } from '@vibe/db/schema';
import { seedAppointmentTypes } from '@vibe/db/seed-helpers';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { ReminderScheduleSchema } from './reminders';

export interface AppointmentTypeRoutesDeps extends RbacDeps {
  db: Database | null;
}

const LOCATIONS = ['VIDEO', 'PHONE', 'IN_PERSON'] as const;

const CreateSchema = z.object({
  name: z.string().min(1).max(60),
  defaultDurationMinutes: z.number().int().min(15).max(480),
  defaultLocationType: z.enum(LOCATIONS),
  description: z.string().max(2000).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  reminderSchedule: ReminderScheduleSchema.nullable().optional(),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  defaultDurationMinutes: z.number().int().min(15).max(480).optional(),
  defaultLocationType: z.enum(LOCATIONS).optional(),
  description: z.string().max(2000).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  reminderSchedule: ReminderScheduleSchema.nullable().optional(),
});

const ReorderSchema = z.object({
  order: z.array(z.string().uuid()).min(1).max(200),
});

export function createAppointmentTypeRouter(deps: AppointmentTypeRoutesDeps): Router {
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
        .from(appointmentTypes)
        .where(eq(appointmentTypes.firmId, firmId))
        .orderBy(asc(appointmentTypes.sortOrder), asc(appointmentTypes.name));
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
        .insert(appointmentTypes)
        .values({
          firmId,
          name: parsed.data.name,
          defaultDurationMinutes: parsed.data.defaultDurationMinutes,
          defaultLocationType: parsed.data.defaultLocationType,
          description: parsed.data.description ?? null,
          color: parsed.data.color ?? null,
          isActive: parsed.data.isActive ?? true,
          sortOrder: parsed.data.sortOrder ?? 0,
          reminderSchedule: parsed.data.reminderSchedule ?? null,
        })
        .returning({ id: appointmentTypes.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'appointment_type',
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
        .from(appointmentTypes)
        .where(and(eq(appointmentTypes.id, req.params['id']!), eq(appointmentTypes.firmId, firmId)))
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.name != null) patch['name'] = parsed.data.name;
      if (parsed.data.defaultDurationMinutes != null) {
        patch['defaultDurationMinutes'] = parsed.data.defaultDurationMinutes;
      }
      if (parsed.data.defaultLocationType != null) {
        patch['defaultLocationType'] = parsed.data.defaultLocationType;
      }
      if (parsed.data.description !== undefined) patch['description'] = parsed.data.description;
      if (parsed.data.color !== undefined) patch['color'] = parsed.data.color;
      if (parsed.data.isActive != null) patch['isActive'] = parsed.data.isActive;
      if (parsed.data.sortOrder != null) patch['sortOrder'] = parsed.data.sortOrder;
      if (parsed.data.reminderSchedule !== undefined) {
        patch['reminderSchedule'] = parsed.data.reminderSchedule;
      }
      await deps.db.update(appointmentTypes).set(patch).where(eq(appointmentTypes.id, existing.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'appointment_type',
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
        .from(appointmentTypes)
        .where(and(eq(appointmentTypes.id, req.params['id']!), eq(appointmentTypes.firmId, firmId)))
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [used] = await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(appointments)
        .where(eq(appointments.appointmentTypeId, existing.id));
      if ((used?.n ?? 0) > 0) {
        // Cannot hard-delete a type with history — deactivate instead.
        res.status(409).json({ error: 'type_in_use', hint: 'deactivate' });
        return;
      }
      await deps.db.delete(appointmentTypes).where(eq(appointmentTypes.id, existing.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'appointment_type',
        entityId: existing.id,
        actorAppUserId: req.staffSession!.appUserId,
        before: existing,
      }).catch(() => undefined);
      res.status(204).end();
    },
  );

  router.post(
    '/seed-defaults',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const inserted = await seedAppointmentTypes(deps.db, firmId);
      res.json({ inserted });
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
            .update(appointmentTypes)
            .set({ sortOrder: i, updatedAt: new Date() })
            .where(
              and(
                eq(appointmentTypes.id, parsed.data.order[i]!),
                eq(appointmentTypes.firmId, firmId),
              ),
            );
        }
      });
      res.json({ ok: true });
    },
  );

  return router;
}
