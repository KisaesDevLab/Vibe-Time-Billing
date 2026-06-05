// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-6 — portal Appointments tab data. Lists confirmed calendar
// appointments (synced from staff calendars + matched to this client)
// across all staff, scoped to the portal identity's accessible clients.
// Read-only; an .ics is served per event for "Add to calendar".

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, calendarEventMatches, calendarEvents } from '@vibe/db/schema';

import { buildIcs } from '../calendar/ics';
import { resolveScope } from './scope';

export interface PortalCalendarDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

export function createPortalCalendarRouter(deps: PortalCalendarDeps): Router {
  const router = express.Router();

  // GET / — upcoming + recent (90d) confirmed appointments for the client(s).
  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const scope = await resolveScope(deps.db, session, req);
    if (scope.clientIds.length === 0) {
      res.json({ items: [] });
      return;
    }
    const cutoff = new Date(Date.now() - 90 * 24 * 3600_000);
    const rows = await deps.db
      .select({
        id: calendarEvents.id,
        subject: calendarEvents.subject,
        startAt: calendarEvents.startAt,
        endAt: calendarEvents.endAt,
        location: calendarEvents.location,
        clientId: calendarEventMatches.clientId,
        staffName: appUsers.fullName,
        attendees: calendarEvents.attendees,
      })
      .from(calendarEvents)
      .innerJoin(calendarEventMatches, eq(calendarEventMatches.eventId, calendarEvents.id))
      .leftJoin(appUsers, eq(appUsers.id, calendarEvents.staffId))
      .where(
        and(
          eq(calendarEventMatches.matchStatus, 'confirmed'),
          inArray(calendarEventMatches.clientId, scope.clientIds),
          isNull(calendarEvents.softDeletedAt),
          gte(calendarEvents.startAt, cutoff),
        ),
      )
      .orderBy(desc(calendarEvents.startAt))
      .limit(200);
    res.json({ items: rows });
  });

  // GET /:id.ics — download a single appointment as an .ics file.
  router.get('/:id.ics', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).end();
      return;
    }
    const scope = await resolveScope(deps.db, session, req);
    const [row] = await deps.db
      .select({
        id: calendarEvents.id,
        subject: calendarEvents.subject,
        startAt: calendarEvents.startAt,
        endAt: calendarEvents.endAt,
        location: calendarEvents.location,
        clientId: calendarEventMatches.clientId,
      })
      .from(calendarEvents)
      .innerJoin(calendarEventMatches, eq(calendarEventMatches.eventId, calendarEvents.id))
      .where(
        and(
          eq(calendarEvents.id, req.params['id']!),
          eq(calendarEventMatches.matchStatus, 'confirmed'),
        ),
      )
      .limit(1);
    if (!row || !row.clientId || !scope.clientIds.includes(row.clientId)) {
      res.status(404).end();
      return;
    }
    const ics = buildIcs({
      uid: `${row.id}@vibe-tb`,
      title: row.subject,
      start: row.startAt,
      end: row.endAt,
      location: row.location,
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="appointment.ics"');
    res.send(ics);
  });

  return router;
}
