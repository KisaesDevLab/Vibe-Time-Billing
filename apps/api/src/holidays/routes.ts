// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Holiday + PTO calendar endpoints (Phase 4 #9-#10). Per-firm holidays
// (app_user_id NULL) and per-user PTO blocks. The time-entry write path
// can use these as warnings; the calendar itself is a simple CRUD.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, lte, or, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, holidayCalendar } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface HolidayRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  appUserId: z.string().uuid().optional(),
  kind: z.enum(['HOLIDAY', 'PTO']).default('HOLIDAY'),
  notes: z.string().max(400).optional(),
});

export function createHolidayRouter(deps: HolidayRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'app_user:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const start = typeof req.query['start'] === 'string' ? req.query['start'] : null;
    const end = typeof req.query['end'] === 'string' ? req.query['end'] : null;
    const userId = uuidQueryParam(req.query['appUserId']);
    if (userId === 'invalid') {
      res.status(400).json({ error: 'invalid_app_user_id' });
      return;
    }
    const conds = [eq(holidayCalendar.firmId, session.firmId)];
    if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
      conds.push(gte(holidayCalendar.endDate, start));
    }
    if (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
      conds.push(lte(holidayCalendar.startDate, end));
    }
    if (userId) {
      // Either user-specific OR firm-wide.
      const both = or(
        eq(holidayCalendar.appUserId, userId),
        sql`${holidayCalendar.appUserId} IS NULL`,
      );
      if (both) conds.push(both);
    }
    const items = await deps.db
      .select()
      .from(holidayCalendar)
      .where(and(...conds))
      .orderBy(desc(holidayCalendar.startDate))
      .limit(500);
    res.json({ items });
  });

  router.post(
    '/',
    requirePermission(deps, 'firm:settings:write'),
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
      if (parsed.data.endDate < parsed.data.startDate) {
        res.status(400).json({ error: 'end_before_start' });
        return;
      }
      if (parsed.data.appUserId) {
        const [user] = await deps.db
          .select({ id: appUsers.id })
          .from(appUsers)
          .where(and(eq(appUsers.id, parsed.data.appUserId), eq(appUsers.firmId, session.firmId)))
          .limit(1);
        if (!user) {
          res.status(404).json({ error: 'user_not_found' });
          return;
        }
      }
      const [row] = await deps.db
        .insert(holidayCalendar)
        .values({
          firmId: session.firmId,
          appUserId: parsed.data.appUserId ?? null,
          name: parsed.data.name,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate,
          kind: parsed.data.kind,
          notes: parsed.data.notes ?? null,
        })
        .returning({ id: holidayCalendar.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'holiday_calendar',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const deleted = await deps.db
        .delete(holidayCalendar)
        .where(
          and(
            eq(holidayCalendar.id, req.params['id']!),
            eq(holidayCalendar.firmId, session.firmId),
          ),
        )
        .returning({ id: holidayCalendar.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'holiday_calendar',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { deleted: true },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
