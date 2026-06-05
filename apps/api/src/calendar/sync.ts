// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-3 — poll sync. Fetches events from a connection's enabled calendars
// (Graph + Google, paginated), upserts them by (connection_id,
// provider_event_id), soft-deletes ones the provider no longer returns, and
// records sync status on the connection. Retryable transport errors throw a
// SyncHttpError (the worker maps 429/5xx to BullMQ backoff); auth failures
// return cleanly so they aren't retried until the staff re-connects.

import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { calendarEvents, staffCalendarConnections, staffCalendarSelections } from '@vibe/db/schema';

import { mapEvent, type NormalizedEvent } from './event-mapper';
import type { CalendarProvider } from './oauth';
import { getProviderCreds } from './store';
import { ensureFreshAccessToken, type ConnectionRow } from './token-manager';

export class SyncHttpError extends Error {
  constructor(
    public status: number,
    public kind: 'auth' | 'rate' | 'server' | 'other',
  ) {
    super(`sync_http_${status}`);
  }
}

function classify(status: number): SyncHttpError {
  if (status === 401 || status === 403) return new SyncHttpError(status, 'auth');
  if (status === 429) return new SyncHttpError(status, 'rate');
  if (status >= 500) return new SyncHttpError(status, 'server');
  return new SyncHttpError(status, 'other');
}

const MAX_PAGES = 25;
const PREFER_UTC = { Prefer: 'outlook.timezone="UTC"' };

function isoNoZone(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, '');
}

async function fetchGraphEvents(
  token: string,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
  fetchImpl: typeof fetch,
): Promise<NormalizedEvent[]> {
  const select =
    'id,subject,bodyPreview,start,end,location,organizer,attendees,isAllDay,iCalUId,webLink';
  const filter = `end/dateTime ge '${isoNoZone(timeMin)}' and start/dateTime le '${isoNoZone(timeMax)}'`;
  let url: string | null =
    `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events` +
    `?$select=${select}&$top=100&$orderby=start/dateTime&$filter=${encodeURIComponent(filter)}`;
  const out: NormalizedEvent[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res: Response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, ...PREFER_UTC },
    });
    if (!res.ok) throw classify(res.status);
    const json = (await res.json().catch(() => ({}))) as {
      value?: unknown[];
      '@odata.nextLink'?: string;
    };
    for (const raw of json.value ?? []) out.push(mapEvent('microsoft', raw));
    url = json['@odata.nextLink'] ?? null;
  }
  return out;
}

async function fetchGoogleEvents(
  token: string,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
  fetchImpl: typeof fetch,
): Promise<NormalizedEvent[]> {
  const base =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events` +
    `?maxResults=250&singleEvents=true&orderBy=startTime` +
    `&timeMin=${encodeURIComponent(timeMin.toISOString())}&timeMax=${encodeURIComponent(timeMax.toISOString())}`;
  const out: NormalizedEvent[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url: string = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
    const res: Response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw classify(res.status);
    const json = (await res.json().catch(() => ({}))) as {
      items?: unknown[];
      nextPageToken?: string;
    };
    for (const raw of json.items ?? []) out.push(mapEvent('google', raw));
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return out;
}

export type SyncOutcome =
  | { ok: true; synced: number; deleted: number; newEventIds: string[] }
  | { ok: false; reason: 'auth_failed' | 'not_configured' };

export interface SyncDeps {
  db: Database;
  fetchImpl?: typeof fetch;
  lookbackDays?: number;
  lookaheadDays?: number;
}

/**
 * Sync one connection. Throws SyncHttpError(kind: rate|server) for the
 * worker to retry; returns {ok:false} for auth failures (no auto-retry).
 */
export async function syncConnection(
  deps: SyncDeps,
  connection: ConnectionRow & { staffId: string },
  now: Date = new Date(),
): Promise<SyncOutcome> {
  const { db } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const provider = connection.provider as CalendarProvider;

  const creds = await getProviderCreds(db, connection.firmId, provider);
  if (!creds) return { ok: false, reason: 'not_configured' };

  let token: string;
  try {
    token = await ensureFreshAccessToken(db, connection, creds, fetchImpl, now);
  } catch {
    await db
      .update(staffCalendarConnections)
      .set({ syncError: 'token_expired', updatedAt: now })
      .where(eq(staffCalendarConnections.id, connection.id));
    return { ok: false, reason: 'auth_failed' };
  }

  const selections = await db
    .select()
    .from(staffCalendarSelections)
    .where(
      and(
        eq(staffCalendarSelections.connectionId, connection.id),
        eq(staffCalendarSelections.syncEnabled, true),
      ),
    );

  const timeMin = new Date(now.getTime() - (deps.lookbackDays ?? 7) * 86400_000);
  const timeMax = new Date(now.getTime() + (deps.lookaheadDays ?? 90) * 86400_000);

  let synced = 0;
  let deleted = 0;
  const newEventIds: string[] = [];

  for (const sel of selections) {
    const events =
      provider === 'microsoft'
        ? await fetchGraphEvents(token, sel.calendarId, timeMin, timeMax, fetchImpl)
        : await fetchGoogleEvents(token, sel.calendarId, timeMin, timeMax, fetchImpl);

    // Which of these already exist (to flag new ones for matching).
    const ids = events.map((e) => e.providerEventId);
    const existing = ids.length
      ? await db
          .select({
            id: calendarEvents.id,
            providerEventId: calendarEvents.providerEventId,
          })
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.connectionId, connection.id),
              inArray(calendarEvents.providerEventId, ids),
            ),
          )
      : [];
    const existingIds = new Set(existing.map((e) => e.providerEventId));
    const seen = new Set<string>();

    for (const e of events) {
      if (e.deleted) continue; // tombstone — handled in the delete sweep
      seen.add(e.providerEventId);
      const row = {
        firmId: connection.firmId,
        staffId: connection.staffId,
        connectionId: connection.id,
        providerEventId: e.providerEventId,
        calendarId: sel.calendarId,
        subject: e.subject,
        bodyPreview: e.bodyPreview,
        startAt: e.startAt,
        endAt: e.endAt,
        location: e.location,
        isAllDay: e.isAllDay,
        organizerEmail: e.organizerEmail,
        organizerName: e.organizerName,
        attendees: e.attendees,
        icalUid: e.icalUid,
        webLink: e.webLink,
        rawEtag: e.rawEtag,
        softDeletedAt: null,
        syncAt: now,
        updatedAt: now,
      };
      const [up] = await db
        .insert(calendarEvents)
        .values(row)
        .onConflictDoUpdate({
          target: [calendarEvents.connectionId, calendarEvents.providerEventId],
          set: {
            calendarId: row.calendarId,
            subject: row.subject,
            bodyPreview: row.bodyPreview,
            startAt: row.startAt,
            endAt: row.endAt,
            location: row.location,
            isAllDay: row.isAllDay,
            organizerEmail: row.organizerEmail,
            organizerName: row.organizerName,
            attendees: row.attendees,
            icalUid: row.icalUid,
            webLink: row.webLink,
            rawEtag: row.rawEtag,
            softDeletedAt: null,
            syncAt: now,
            updatedAt: now,
          },
        })
        .returning({ id: calendarEvents.id });
      synced += 1;
      if (!existingIds.has(e.providerEventId) && up) newEventIds.push(up.id);
    }

    // Soft-delete live events for this calendar that the provider no longer
    // returns (and explicit Google tombstones). TB-origin events (CAL-9
    // write-back) are excluded: TB owns them, and provider propagation lag
    // could otherwise soft-delete one between the push and the next poll.
    const tombstones = new Set(events.filter((e) => e.deleted).map((e) => e.providerEventId));
    const current = await db
      .select({ id: calendarEvents.id, providerEventId: calendarEvents.providerEventId })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.connectionId, connection.id),
          eq(calendarEvents.calendarId, sel.calendarId),
          eq(calendarEvents.tbOrigin, false),
          isNull(calendarEvents.softDeletedAt),
        ),
      );
    const toDelete = current
      .filter((c) => !seen.has(c.providerEventId) || tombstones.has(c.providerEventId))
      .map((c) => c.id);
    if (toDelete.length) {
      await db
        .update(calendarEvents)
        .set({ softDeletedAt: now, updatedAt: now })
        .where(inArray(calendarEvents.id, toDelete));
      deleted += toDelete.length;
    }
  }

  await db
    .update(staffCalendarConnections)
    .set({ lastSyncedAt: now, syncError: null, consecutiveFailures: 0, updatedAt: now })
    .where(eq(staffCalendarConnections.id, connection.id));

  return { ok: true, synced, deleted, newEventIds };
}
