// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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
import { offices } from '@vibe/db/schema';

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

      const cacheKey = `slots:${[...staffIds].sort().join(',')}:${date}:${durationMinutes}`;
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

      const timezone = await firmTimezone(deps.db, session.firmId);
      const result = await getAvailableSlots({
        db: deps.db,
        staffIds,
        date,
        durationMinutes,
        timezone,
        busyProvider: providerFor(session.firmId),
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
      const timezone = await firmTimezone(deps.db, session.firmId);
      const result = await getMonthAvailability({
        db: deps.db,
        staffIds,
        year,
        month,
        durationMinutes,
        timezone,
        busyProvider: providerFor(session.firmId),
      });
      res.json(result);
    },
  );

  return router;
}
