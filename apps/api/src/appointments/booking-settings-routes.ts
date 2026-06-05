// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-1 — Per-staff booking configuration. Mounted at /api/staff/booking.
// A staff member manages their OWN settings/availability; admins
// (app_user:write) may manage anyone's. Booking settings drive the slot
// engine (buffers, notice, increment) and the booking on/off switch;
// availability is the weekly hours grid (one row per active day).
//
//   GET   /:staffId/settings      — booking settings (defaults if unset)
//   PATCH /:staffId/settings      — upsert booking settings
//   GET   /:staffId/availability  — weekly availability rows
//   PUT   /:staffId/availability  — full replace of availability rows

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { appUsers, staffAvailability, staffBookingSettings } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { userHasPermission, type RbacDeps } from '../auth/rbac-middleware';

export interface BookingSettingsRoutesDeps extends RbacDeps {
  db: Database | null;
}

const DEFAULT_SETTINGS = {
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeHours: 1,
  slotIncrementMinutes: 30,
  bookingEnabled: true,
};

const SettingsSchema = z.object({
  bufferBeforeMinutes: z.number().int().min(0).max(120).optional(),
  bufferAfterMinutes: z.number().int().min(0).max(120).optional(),
  minNoticeHours: z.number().int().min(0).max(168).optional(),
  slotIncrementMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).optional(),
  bookingEnabled: z.boolean().optional(),
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const AvailabilitySchema = z.object({
  rows: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        startTime: z.string().regex(TIME_RE),
        endTime: z.string().regex(TIME_RE),
        isActive: z.boolean().optional(),
      }),
    )
    .max(50),
});

export function createBookingSettingsRouter(deps: BookingSettingsRoutesDeps): Router {
  const router = express.Router();

  // Self-or-admin gate: a staff member may read/write their own config;
  // app_user:write (manager/partner/admin) may touch anyone's.
  function selfOrAdmin(req: Request, res: Response, next: NextFunction): void {
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const staffId = req.params['staffId'];
    if (staffId && staffId === session.appUserId) {
      next();
      return;
    }
    void userHasPermission(deps, session.appUserId, 'app_user:write')
      .then((ok) => {
        if (!ok) {
          res.status(403).json({ error: 'forbidden', required: 'app_user:write' });
          return;
        }
        next();
      })
      .catch(() => res.status(500).json({ error: 'rbac_error' }));
  }

  // Confirm the target staff belongs to the caller's firm.
  async function sameFirm(db: Database, staffId: string, firmId: string): Promise<boolean> {
    const [row] = await db
      .select({ firmId: appUsers.firmId })
      .from(appUsers)
      .where(eq(appUsers.id, staffId))
      .limit(1);
    return row?.firmId === firmId;
  }

  router.get('/:staffId/settings', selfOrAdmin, async (req: Request, res: Response) => {
    const session = req.staffSession!;
    const staffId = req.params['staffId']!;
    if (!deps.db) {
      res.json({ settings: { staffId, ...DEFAULT_SETTINGS } });
      return;
    }
    if (!(await sameFirm(deps.db, staffId, session.firmId))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const [row] = await deps.db
      .select()
      .from(staffBookingSettings)
      .where(eq(staffBookingSettings.staffId, staffId))
      .limit(1);
    res.json({ settings: row ?? { staffId, ...DEFAULT_SETTINGS } });
  });

  router.patch('/:staffId/settings', selfOrAdmin, async (req: Request, res: Response) => {
    const session = req.staffSession!;
    const staffId = req.params['staffId']!;
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    if (!(await sameFirm(deps.db, staffId, session.firmId))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const values = { staffId, ...DEFAULT_SETTINGS, ...parsed.data, updatedAt: new Date() };
    await deps.db
      .insert(staffBookingSettings)
      .values(values)
      .onConflictDoUpdate({
        target: staffBookingSettings.staffId,
        set: { ...parsed.data, updatedAt: new Date() },
      });
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'staff_booking_settings',
      entityId: staffId,
      actorAppUserId: session.appUserId,
      after: parsed.data,
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  router.get('/:staffId/availability', selfOrAdmin, async (req: Request, res: Response) => {
    const session = req.staffSession!;
    const staffId = req.params['staffId']!;
    if (!deps.db) {
      res.json({ rows: [] });
      return;
    }
    if (!(await sameFirm(deps.db, staffId, session.firmId))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const rows = await deps.db
      .select()
      .from(staffAvailability)
      .where(eq(staffAvailability.staffId, staffId))
      .orderBy(asc(staffAvailability.dayOfWeek), asc(staffAvailability.startTime));
    res.json({ rows });
  });

  router.put('/:staffId/availability', selfOrAdmin, async (req: Request, res: Response) => {
    const session = req.staffSession!;
    const staffId = req.params['staffId']!;
    const parsed = AvailabilitySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    if (!(await sameFirm(deps.db, staffId, session.firmId))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Reject inverted ranges.
    for (const r of parsed.data.rows) {
      if (r.endTime <= r.startTime) {
        res.status(400).json({ error: 'end_before_start', dayOfWeek: r.dayOfWeek });
        return;
      }
    }
    const db = deps.db;
    await db.transaction(async (tx) => {
      await tx.delete(staffAvailability).where(eq(staffAvailability.staffId, staffId));
      if (parsed.data.rows.length > 0) {
        await tx.insert(staffAvailability).values(
          parsed.data.rows.map((r) => ({
            staffId,
            dayOfWeek: r.dayOfWeek,
            startTime: r.startTime,
            endTime: r.endTime,
            isActive: r.isActive ?? true,
          })),
        );
      }
    });
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'staff_availability',
      entityId: staffId,
      actorAppUserId: session.appUserId,
      after: { rows: parsed.data.rows.length },
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  return router;
}
