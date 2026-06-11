// SPDX-License-Identifier: Elastic-2.0
//
// BK-2 — slot availability API. Mounted at /api/booking. Returns the
// free/busy intersection across one or more staff for a date (or a
// month-grid of bookable days). Read access = appointment:read.
//
//   GET /slots?staffIds=a,b&date=YYYY-MM-DD&durationMinutes=N
//   GET /slots/month?staffIds=a,b&year=&month=&durationMinutes=N
//
// Results are cached in Redis for 2 minutes keyed by sorted staff +
// date/duration; the cache is busted on booking create/sync (see BK-4).

import express, { type Request, type Response, type Router } from 'express';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import { appUsers, offices } from '@vibe/db/schema';
import { inArray } from 'drizzle-orm';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';
import { createFreeBusyProvider } from '../calendar/freebusy';
import { getAvailableSlots, getMonthAvailability, type StaffBusyProvider } from './availability';

export interface SlotsRoutesDeps extends RbacDeps {
  db: Database | null;
  redis?: Redis | null;
  /** Test seam — overrides the provider free/busy source. */
  busyProvider?: StaffBusyProvider;
  fetchImpl?: typeof fetch;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CACHE_TTL_SECONDS = 120;
const LOCATIONS = new Set(['VIDEO', 'PHONE', 'IN_PERSON']);

function parseLocation(raw: unknown): string | undefined {
  return typeof raw === 'string' && LOCATIONS.has(raw) ? raw : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseLocationId(raw: unknown): string | undefined {
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : undefined;
}

function parseStaffIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** Every requested staff id must belong to the caller's firm (no cross-firm
 *  free/busy disclosure). */
async function staffInFirm(db: Database, staffIds: string[], firmId: string): Promise<boolean> {
  if (staffIds.length === 0) return false;
  const rows = await db
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(and(inArray(appUsers.id, staffIds), eq(appUsers.firmId, firmId)));
  return rows.length === staffIds.length;
}

async function firmTimezone(db: Database, firmId: string): Promise<string> {
  const [row] = await db
    .select({ tz: offices.timezone })
    .from(offices)
    .where(and(eq(offices.firmId, firmId), eq(offices.isDefault, true)))
    .limit(1);
  return row?.tz ?? 'America/Chicago';
}

export function createSlotsRouter(deps: SlotsRoutesDeps): Router {
  const router = express.Router();

  function providerFor(firmId: string): StaffBusyProvider {
    return (
      deps.busyProvider ??
      createFreeBusyProvider({ db: deps.db!, firmId, fetchImpl: deps.fetchImpl })
    );
  }

  router.get(
    '/slots',
    requirePermission(deps, 'appointment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ slots: [], timezone: 'UTC', date: '' });
        return;
      }
      const staffIds = parseStaffIds(req.query['staffIds']);
      const date = typeof req.query['date'] === 'string' ? req.query['date'] : '';
      const durationMinutes = Number(req.query['durationMinutes']);
      if (
        staffIds.length === 0 ||
        !DATE_RE.test(date) ||
        !Number.isFinite(durationMinutes) ||
        durationMinutes <= 0
      ) {
        res.status(400).json({ error: 'invalid_params' });
        return;
      }
      if (!(await staffInFirm(deps.db, staffIds, session.firmId))) {
        res.status(404).json({ error: 'unknown_staff' });
        return;
      }

      const location = parseLocation(req.query['location']);
      const locationOptionId = parseLocationId(req.query['locationId']);
      const cacheKey = `slots:${[...staffIds].sort().join(',')}:${date}:${durationMinutes}:${location ?? 'any'}:${locationOptionId ?? 'any'}`;
      if (deps.redis && !deps.busyProvider) {
        try {
          const hit = await deps.redis.get(cacheKey);
          if (hit) {
            res.json(JSON.parse(hit));
            return;
          }
        } catch (err) {
          logger.warn({ err }, 'slots cache read failed');
        }
      }

      const excludeAppointmentId =
        typeof req.query['excludeAppointmentId'] === 'string'
          ? req.query['excludeAppointmentId']
          : undefined;
      const timezone = await firmTimezone(deps.db, session.firmId);
      const result = await getAvailableSlots({
        db: deps.db,
        staffIds,
        date,
        durationMinutes,
        timezone,
        busyProvider: providerFor(session.firmId),
        excludeAppointmentId,
        location,
        locationOptionId,
      });
      if (deps.redis && !deps.busyProvider) {
        try {
          await deps.redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
        } catch (err) {
          logger.warn({ err }, 'slots cache write failed');
        }
      }
      res.json(result);
    },
  );

  router.get(
    '/slots/month',
    requirePermission(deps, 'appointment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ days: {}, timezone: 'UTC' });
        return;
      }
      const staffIds = parseStaffIds(req.query['staffIds']);
      const year = Number(req.query['year']);
      const month = Number(req.query['month']);
      const durationMinutes = Number(req.query['durationMinutes']);
      if (
        staffIds.length === 0 ||
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12 ||
        !Number.isFinite(durationMinutes) ||
        durationMinutes <= 0
      ) {
        res.status(400).json({ error: 'invalid_params' });
        return;
      }
      if (!(await staffInFirm(deps.db, staffIds, session.firmId))) {
        res.status(404).json({ error: 'unknown_staff' });
        return;
      }
      const excludeAppointmentId =
        typeof req.query['excludeAppointmentId'] === 'string'
          ? req.query['excludeAppointmentId']
          : undefined;
      const location = parseLocation(req.query['location']);
      const locationOptionId = parseLocationId(req.query['locationId']);
      // Month grids are ~31 day computations per request — cache like the
      // day endpoint. Key shares the `slots:` prefix so the BK-4 bust
      // (SCAN MATCH slots:*) invalidates it on booking create/sync.
      // Reschedule requests (excludeAppointmentId) skip the cache — the
      // exclusion changes the result per appointment.
      const monthCacheKey = `slots:month:${[...staffIds].sort().join(',')}:${year}-${month}:${durationMinutes}:${location ?? 'any'}:${locationOptionId ?? 'any'}`;
      const cacheable = !excludeAppointmentId && deps.redis && !deps.busyProvider;
      if (cacheable) {
        try {
          const hit = await deps.redis!.get(monthCacheKey);
          if (hit) {
            res.json(JSON.parse(hit));
            return;
          }
        } catch (err) {
          logger.warn({ err }, 'month slots cache read failed');
        }
      }
      const timezone = await firmTimezone(deps.db, session.firmId);
      const result = await getMonthAvailability({
        db: deps.db,
        staffIds,
        year,
        month,
        durationMinutes,
        timezone,
        busyProvider: providerFor(session.firmId),
        excludeAppointmentId,
        location,
        locationOptionId,
      });
      if (cacheable) {
        try {
          await deps.redis!.set(monthCacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
        } catch (err) {
          logger.warn({ err }, 'month slots cache write failed');
        }
      }
      res.json(result);
    },
  );

  return router;
}
