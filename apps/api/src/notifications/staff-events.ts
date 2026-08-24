// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-2 — staff event stream. One Server-Sent-Events connection per signed
// in staff tab/desktop shell replaces the Shell's four 30-second polls and
// gives the desktop app something to turn into native toasts.
//
//   GET /api/staff/events            text/event-stream, cookie-auth
//
// Events (all JSON payloads):
//   hello        { counts }                         first frame
//   counts       { teamUnread, notifUnread, requestsNew, intakeNew }
//   notification { id, category, title, body, href, createdAt }
//                category ∈ message | team | intake | request | alert |
//                approval | appointment | system
//   appointment  { id, title, startsAt, href, minutesUntil }
//
// Mechanics: every connection ticks on a short interval (POLL_MS), reads
// the four counters + any staff_notification rows newer than its cursor,
// and emits only what changed. A Redis pub/sub "poke" (pokeStaffEvents)
// from a write path makes the next tick happen immediately, so a client
// message reaches the desktop in well under a second when Redis is
// present and within POLL_MS otherwise. The poll is the source of truth;
// the poke is only latency. That keeps the stream correct across API
// replicas and when a write path forgets to poke.
//
// Privacy: payloads carry titles and ids, never document contents or
// message bodies beyond the short summary already stored on the
// notification row.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import { appointments, appointmentStaff, staffNotifications } from '@vibe/db/schema';

import { resolveUserPermissions, type RbacDeps } from '../auth/rbac-middleware';
import { addLocalListener, ensureSubscriber } from './staff-events-bus';

export {
  closeStaffEventsSubscriber,
  pokeFirmStaffEvents,
  pokeStaffEvents,
  setStaffEventsPublisher,
} from './staff-events-bus';
import { logger } from '../logger';
import { EMPTY_COUNTS, loadStaffCounts, type StaffCounts } from './staff-counts';

export const POLL_MS = 5_000;
export const HEARTBEAT_MS = 25_000;
/** Native "starts soon" reminder lead time. */
export const APPOINTMENT_LEAD_MINUTES = 15;
/** Look-back for "new" notification rows; must exceed any clock skew. */
export const NOTIF_WINDOW_MS = 2 * 60_000;

export type StaffEventCategory =
  | 'message'
  | 'team'
  | 'intake'
  | 'request'
  | 'alert'
  | 'approval'
  | 'appointment'
  | 'system';

export interface StaffNotificationEvent {
  id: string;
  category: StaffEventCategory;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: string;
}

export interface StaffEventsDeps extends RbacDeps {
  db: Database | null;
  /** Shared ioredis client (publisher). Optional — tests run without. */
  redis?: Redis | null;
  /** Test seam: override timers. */
  pollMs?: number;
  heartbeatMs?: number;
}

// ---- categorisation -----------------------------------------------------

/** staff_notification.type → stream category (drives per-category mute
 *  and the toast icon on the desktop). Unknown types fall to 'alert'. */
export function categoryForType(type: string): StaffEventCategory {
  const t = type.toLowerCase();
  if (t.startsWith('team')) return 'team';
  if (t.includes('message')) return 'message';
  if (t.includes('intake')) return 'intake';
  // Booking/appointment types before the generic 'request' match
  // ('booking_request', 'reschedule_requested').
  if (t.includes('appointment') || t.includes('booking') || t.includes('reschedule')) {
    return 'appointment';
  }
  if (t.includes('request')) return 'request';
  if (t.includes('approval') || t.includes('approve')) return 'approval';
  if (t.includes('signature') || t.includes('esign')) return 'alert';
  return 'alert';
}

function countsEqual(a: StaffCounts, b: StaffCounts): boolean {
  return (
    a.teamUnread === b.teamUnread &&
    a.notifUnread === b.notifUnread &&
    a.requestsNew === b.requestsNew &&
    a.intakeNew === b.intakeNew
  );
}

// ---- router ---------------------------------------------------------------

export function createStaffEventsRouter(deps: StaffEventsDeps): Router {
  const router = express.Router();
  const pollMs = deps.pollMs ?? POLL_MS;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;

  router.get('/', async (req: Request, res: Response) => {
    const session = req.staffSession!;
    const db = deps.db;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Caddy/nginx must not buffer the stream.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (!db) {
      send('hello', { counts: EMPTY_COUNTS });
      const hb = setInterval(() => {
        if (!res.writableEnded) res.write(': hb\n\n');
      }, heartbeatMs);
      req.on('close', () => clearInterval(hb));
      return;
    }

    const perms = await resolveUserPermissions(deps, session.appUserId, session.firmId);
    const subject = { appUserId: session.appUserId, firmId: session.firmId, perms };

    let counts: StaffCounts;
    try {
      counts = await loadStaffCounts(db, subject);
    } catch (err) {
      logger.warn({ err }, 'staff-events: initial counts failed');
      counts = EMPTY_COUNTS;
    }
    // Which staff_notification rows this connection has already pushed.
    // Id-based rather than a wall-clock cursor: DB and API clocks can
    // disagree by a few ms, which is enough to drop a row created in the
    // same instant the stream opened. We look back NOTIF_WINDOW_MS each
    // tick and emit only unseen ids; priming with the current window means
    // a reconnect never replays the backlog (the counts frame carries the
    // unread total for the badge).
    const seen = new Set<string>();
    const recentRows = (since: Date) =>
      db
        .select({
          id: staffNotifications.id,
          type: staffNotifications.type,
          title: staffNotifications.title,
          body: staffNotifications.body,
          actionUrl: staffNotifications.actionUrl,
          createdAt: staffNotifications.createdAt,
        })
        .from(staffNotifications)
        .where(
          and(
            eq(staffNotifications.recipientAppUserId, session.appUserId),
            gt(staffNotifications.createdAt, since),
          ),
        )
        .orderBy(asc(staffNotifications.createdAt))
        .limit(200);
    try {
      for (const r of await recentRows(new Date(Date.now() - NOTIF_WINDOW_MS))) seen.add(r.id);
    } catch (err) {
      logger.warn({ err }, 'staff-events: priming failed');
    }
    const announcedAppointments = new Set<string>();
    send('hello', { counts });

    let ticking = false;
    let closed = false;

    const tick = async (): Promise<void> => {
      if (ticking || closed) return;
      ticking = true;
      try {
        const now = new Date();
        const next = await loadStaffCounts(db, subject);
        if (!countsEqual(counts, next)) {
          counts = next;
          send('counts', counts);
        }

        const rows = await recentRows(new Date(now.getTime() - NOTIF_WINDOW_MS));
        const windowIds = new Set<string>();
        for (const r of rows) {
          windowIds.add(r.id);
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          send('notification', {
            id: r.id,
            category: categoryForType(r.type),
            title: r.title,
            body: r.body,
            href: r.actionUrl,
            createdAt: r.createdAt.toISOString(),
          } satisfies StaffNotificationEvent);
        }
        // Forget ids that have aged out of the window (bounded memory).
        for (const id of seen) if (!windowIds.has(id)) seen.delete(id);

        if (perms.has('appointment:read')) {
          const horizon = new Date(now.getTime() + APPOINTMENT_LEAD_MINUTES * 60_000);
          const soon = await db
            .selectDistinct({
              id: appointments.id,
              title: appointments.title,
              startsAt: appointments.startsAt,
            })
            .from(appointments)
            .leftJoin(appointmentStaff, eq(appointmentStaff.appointmentId, appointments.id))
            .where(
              and(
                eq(appointments.firmId, session.firmId),
                eq(appointments.status, 'SCHEDULED'),
                gt(appointments.startsAt, now),
                sql`${appointments.startsAt} <= ${horizon}`,
                or(
                  eq(appointments.leadAppUserId, session.appUserId),
                  eq(appointmentStaff.staffId, session.appUserId),
                ),
              ),
            )
            .limit(20);
          for (const a of soon) {
            if (announcedAppointments.has(a.id)) continue;
            announcedAppointments.add(a.id);
            send('appointment', {
              id: a.id,
              title: a.title,
              startsAt: a.startsAt.toISOString(),
              href: `/appointments?focus=${a.id}`,
              minutesUntil: Math.max(
                0,
                Math.round((a.startsAt.getTime() - now.getTime()) / 60_000),
              ),
            });
          }
        }
      } catch (err) {
        logger.warn({ err }, 'staff-events: tick failed');
      } finally {
        ticking = false;
      }
    };

    const interval = setInterval(() => void tick(), pollMs);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': hb\n\n');
    }, heartbeatMs);
    if (deps.redis) ensureSubscriber(deps.redis);
    const unsubscribeUser = addLocalListener(session.appUserId, () => void tick());
    const unsubscribeFirm = addLocalListener(`firm:${session.firmId}`, () => void tick());
    const unsubscribe = (): void => {
      unsubscribeUser();
      unsubscribeFirm();
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  return router;
}

/** Resolve the recipients of an appointment (lead + assigned staff) for
 *  poking after a booking write. */
export async function appointmentRecipients(
  db: Database,
  appointmentId: string,
): Promise<string[]> {
  const [appt] = await db
    .select({ lead: appointments.leadAppUserId })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  const staff = await db
    .select({ id: appointmentStaff.staffId })
    .from(appointmentStaff)
    .where(inArray(appointmentStaff.appointmentId, [appointmentId]));
  const ids = staff.map((s) => s.id);
  if (appt?.lead) ids.push(appt.lead);
  return ids;
}
