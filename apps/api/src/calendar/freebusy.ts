// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-2 — provider free/busy. For a staff member, query each connected
// provider for busy intervals over a window:
//   * Microsoft Graph  POST /me/calendar/getSchedule (by mailbox email)
//   * Google Calendar  POST /freeBusy (by selected calendar ids)
// On any provider error we fall back to the locally-ingested
// `calendar_events` rows so booking never hard-fails on a flaky API.
//
// Returned intervals feed the slot intersection engine (availability.ts).

import { and, eq, gte, isNull, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { calendarEvents, staffCalendarConnections, staffCalendarSelections } from '@vibe/db/schema';

import { logger } from '../logger';
import type { CalendarProvider } from './oauth';
import { getProviderCreds } from './store';
import { ensureFreshAccessToken } from './token-manager';
import type { BusyInterval, StaffBusyProvider } from '../appointments/availability';

export interface FreeBusyDeps {
  db: Database;
  firmId: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}

async function graphGetSchedule(
  token: string,
  mailbox: string,
  start: Date,
  end: Date,
  fetchImpl: typeof fetch,
): Promise<BusyInterval[]> {
  const res = await fetchImpl('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schedules: [mailbox],
      startTime: { dateTime: start.toISOString(), timeZone: 'UTC' },
      endTime: { dateTime: end.toISOString(), timeZone: 'UTC' },
      availabilityViewInterval: 15,
    }),
  });
  if (!res.ok) throw new Error(`graph_getschedule_${res.status}`);
  const json = (await res.json().catch(() => ({}))) as {
    value?: {
      scheduleItems?: {
        status?: string;
        start?: { dateTime?: string };
        end?: { dateTime?: string };
      }[];
    }[];
  };
  const out: BusyInterval[] = [];
  for (const sched of json.value ?? []) {
    for (const item of sched.scheduleItems ?? []) {
      // Treat anything not explicitly free as busy.
      if (item.status === 'free') continue;
      const s = item.start?.dateTime
        ? new Date(`${item.start.dateTime}Z`.replace(/Z+$/, 'Z'))
        : null;
      const e = item.end?.dateTime ? new Date(`${item.end.dateTime}Z`.replace(/Z+$/, 'Z')) : null;
      if (s && e && !isNaN(s.getTime()) && !isNaN(e.getTime())) out.push({ start: s, end: e });
    }
  }
  return out;
}

async function googleFreeBusy(
  token: string,
  calendarIds: string[],
  start: Date,
  end: Date,
  fetchImpl: typeof fetch,
): Promise<BusyInterval[]> {
  const res = await fetchImpl('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: calendarIds.map((id) => ({ id })),
    }),
  });
  if (!res.ok) throw new Error(`google_freebusy_${res.status}`);
  const json = (await res.json().catch(() => ({}))) as {
    calendars?: Record<string, { busy?: { start?: string; end?: string }[] }>;
  };
  const out: BusyInterval[] = [];
  for (const cal of Object.values(json.calendars ?? {})) {
    for (const b of cal.busy ?? []) {
      if (b.start && b.end) {
        const s = new Date(b.start);
        const e = new Date(b.end);
        if (!isNaN(s.getTime()) && !isNaN(e.getTime())) out.push({ start: s, end: e });
      }
    }
  }
  return out;
}

/** Locally-ingested events for a staff member in the window (fallback). */
async function calendarEventsBusy(
  db: Database,
  staffId: string,
  start: Date,
  end: Date,
): Promise<BusyInterval[]> {
  const rows = await db
    .select({ start: calendarEvents.startAt, end: calendarEvents.endAt })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.staffId, staffId),
        isNull(calendarEvents.softDeletedAt),
        lte(calendarEvents.startAt, end),
        gte(calendarEvents.endAt, start),
      ),
    );
  const out: BusyInterval[] = [];
  for (const r of rows) {
    if (r.start && r.end) out.push({ start: r.start, end: r.end });
  }
  return out;
}

/**
 * Build a StaffBusyProvider for one firm. Queries each staff member's
 * connected providers for free/busy; on error falls back to the ingested
 * calendar_events. Safe to reuse across many staff within a request.
 */
export function createFreeBusyProvider(deps: FreeBusyDeps): StaffBusyProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? new Date();
  const { db, firmId } = deps;

  return {
    async getBusy(staffId: string, start: Date, end: Date): Promise<BusyInterval[]> {
      const conns = await db
        .select()
        .from(staffCalendarConnections)
        .where(
          and(
            eq(staffCalendarConnections.firmId, firmId),
            eq(staffCalendarConnections.staffId, staffId),
            eq(staffCalendarConnections.enabled, true),
          ),
        );
      if (conns.length === 0) {
        return calendarEventsBusy(db, staffId, start, end);
      }
      const all: BusyInterval[] = [];
      for (const conn of conns) {
        const provider = conn.provider as CalendarProvider;
        try {
          const creds = await getProviderCreds(db, firmId, provider);
          if (!creds) throw new Error('not_configured');
          const token = await ensureFreshAccessToken(db, conn, creds, fetchImpl, now);
          if (provider === 'microsoft') {
            const mailbox = conn.providerEmail ?? '';
            all.push(...(await graphGetSchedule(token, mailbox, start, end, fetchImpl)));
          } else {
            const sels = await db
              .select({ calendarId: staffCalendarSelections.calendarId })
              .from(staffCalendarSelections)
              .where(
                and(
                  eq(staffCalendarSelections.connectionId, conn.id),
                  eq(staffCalendarSelections.syncEnabled, true),
                ),
              );
            const ids = sels.map((s) => s.calendarId);
            if (ids.length > 0) {
              all.push(...(await googleFreeBusy(token, ids, start, end, fetchImpl)));
            }
          }
        } catch (err) {
          // Provider unavailable → fall back to ingested events for this staff.
          logger.warn(
            { err, staffId, provider },
            'free/busy provider failed; using calendar_events',
          );
          all.push(...(await calendarEventsBusy(db, staffId, start, end)));
        }
      }
      return all;
    },
  };
}
