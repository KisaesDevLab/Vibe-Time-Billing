// SPDX-License-Identifier: Elastic-2.0
//
// CAL-9 — calendar write-back (two-way sync). Gated behind
// FEATURE_CALENDAR_WRITE. When enabled, TB can push an event to a staff
// member's connected calendar (Microsoft Graph / Google Calendar), and
// update/delete the events it owns. Each pushed event is mirrored into
// calendar_events with tb_origin=true so the read sync recognises it as its
// own (the poll sync never soft-deletes tb_origin rows — see sync.ts).
//
// Writers use plain fetch against the documented REST endpoints, matching the
// read path in sync.ts (no SDKs). See docs/calendar-writeback-v2.md.

import { and, eq, asc } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { calendarEvents, staffCalendarConnections, staffCalendarSelections } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { hasWriteScope, isCalendarWriteEnabled, type CalendarProvider } from './oauth';
import { getProviderCreds, loadConnection } from './store';
import { ensureFreshAccessToken, type ConnectionRow } from './token-manager';

export { isCalendarWriteEnabled };

export interface WriteEventInput {
  title: string;
  start: Date;
  end: Date;
  location?: string | null;
  /** Free-text event body (appointment type, other staff, engagement). */
  description?: string | null;
  attendees?: string[];
}

export interface WriteEventResult {
  providerEventId: string;
  webLink: string | null;
  rawEtag: string | null;
}

/** Typed write-back failure; the route layer maps `code` → HTTP status. */
export class CalendarWriteError extends Error {
  constructor(
    public code:
      | 'write_disabled'
      | 'not_found'
      | 'not_configured'
      | 'write_scope_missing'
      | 'reauth_required'
      | 'provider_failed',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'CalendarWriteError';
  }
}

// ---- Provider writers ------------------------------------------------

// Graph wants a naive datetime in the declared zone; we always send UTC.
function graphDateTime(d: Date): { dateTime: string; timeZone: string } {
  return { dateTime: d.toISOString().replace(/\.\d+Z$/, ''), timeZone: 'UTC' };
}

/** One attendee's email + provider-normalized response, for write-back. */
export interface AttendeeWrite {
  email: string;
  name: string | null;
  /** Local response_status: 'accepted' | 'declined' | 'tentative' | null. */
  responseStatus: string | null;
}

function graphResponse(s: string | null): string {
  if (s === 'accepted') return 'accepted';
  if (s === 'declined') return 'declined';
  if (s === 'tentative' || s === 'tentativelyAccepted') return 'tentativelyAccepted';
  return 'notResponded';
}

function googleResponse(s: string | null): string {
  return s === 'accepted' || s === 'declined' || s === 'tentative' ? s : 'needsAction';
}

export interface ProviderEventWriter {
  createEvent(calendarId: string, token: string, input: WriteEventInput): Promise<WriteEventResult>;
  updateEvent(
    calendarId: string,
    token: string,
    providerEventId: string,
    input: Partial<WriteEventInput>,
  ): Promise<WriteEventResult>;
  deleteEvent(calendarId: string, token: string, providerEventId: string): Promise<void>;
  updateAttendees(
    calendarId: string,
    token: string,
    providerEventId: string,
    attendees: AttendeeWrite[],
  ): Promise<void>;
}

async function readError(res: Response): Promise<string> {
  const txt = await res.text().catch(() => '');
  return `${res.status} ${txt.slice(0, 300)}`;
}

export class GraphEventWriter implements ProviderEventWriter {
  constructor(private fetchImpl: typeof fetch = fetch) {}

  private body(input: Partial<WriteEventInput>): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    if (input.title !== undefined) b['subject'] = input.title;
    if (input.start !== undefined) b['start'] = graphDateTime(input.start);
    if (input.end !== undefined) b['end'] = graphDateTime(input.end);
    if (input.location !== undefined) {
      b['location'] = { displayName: input.location ?? '' };
    }
    if (input.description !== undefined) {
      b['body'] = { contentType: 'text', content: input.description ?? '' };
    }
    if (input.attendees !== undefined) {
      b['attendees'] = input.attendees.map((address) => ({
        emailAddress: { address },
        type: 'required',
      }));
    }
    return b;
  }

  private toResult(j: { id?: string; webLink?: string; '@odata.etag'?: string }): WriteEventResult {
    return {
      providerEventId: j.id ?? '',
      webLink: j.webLink ?? null,
      rawEtag: j['@odata.etag'] ?? null,
    };
  }

  async createEvent(
    calendarId: string,
    token: string,
    input: WriteEventInput,
  ): Promise<WriteEventResult> {
    const res = await this.fetchImpl(
      `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.body(input)),
      },
    );
    if (!res.ok) throw new CalendarWriteError('provider_failed', await readError(res));
    const j = (await res.json().catch(() => ({}))) as Parameters<typeof this.toResult>[0];
    if (!j.id) throw new CalendarWriteError('provider_failed', 'graph_create_no_id');
    return this.toResult(j);
  }

  async updateEvent(
    calendarId: string,
    token: string,
    providerEventId: string,
    input: Partial<WriteEventInput>,
  ): Promise<WriteEventResult> {
    const res = await this.fetchImpl(
      `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.body(input)),
      },
    );
    if (!res.ok) throw new CalendarWriteError('provider_failed', await readError(res));
    const j = (await res.json().catch(() => ({}))) as Parameters<typeof this.toResult>[0];
    return this.toResult({ ...j, id: j.id ?? providerEventId });
  }

  async deleteEvent(calendarId: string, token: string, providerEventId: string): Promise<void> {
    const res = await this.fetchImpl(
      `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    // 404 = already gone — treat as success (idempotent delete).
    if (!res.ok && res.status !== 404) {
      throw new CalendarWriteError('provider_failed', await readError(res));
    }
  }

  async updateAttendees(
    calendarId: string,
    token: string,
    providerEventId: string,
    attendees: AttendeeWrite[],
  ): Promise<void> {
    const res = await this.fetchImpl(
      `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attendees: attendees.map((a) => ({
            emailAddress: { address: a.email, name: a.name ?? undefined },
            type: 'required',
            status: { response: graphResponse(a.responseStatus) },
          })),
        }),
      },
    );
    if (!res.ok) throw new CalendarWriteError('provider_failed', await readError(res));
  }
}

export class GoogleEventWriter implements ProviderEventWriter {
  constructor(private fetchImpl: typeof fetch = fetch) {}

  private body(input: Partial<WriteEventInput>): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    if (input.title !== undefined) b['summary'] = input.title;
    if (input.start !== undefined) b['start'] = { dateTime: input.start.toISOString() };
    if (input.end !== undefined) b['end'] = { dateTime: input.end.toISOString() };
    if (input.location !== undefined) b['location'] = input.location ?? '';
    if (input.description !== undefined) b['description'] = input.description ?? '';
    if (input.attendees !== undefined) {
      b['attendees'] = input.attendees.map((email) => ({ email }));
    }
    return b;
  }

  private toResult(j: { id?: string; htmlLink?: string; etag?: string }): WriteEventResult {
    return { providerEventId: j.id ?? '', webLink: j.htmlLink ?? null, rawEtag: j.etag ?? null };
  }

  async createEvent(
    calendarId: string,
    token: string,
    input: WriteEventInput,
  ): Promise<WriteEventResult> {
    const res = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.body(input)),
      },
    );
    if (!res.ok) throw new CalendarWriteError('provider_failed', await readError(res));
    const j = (await res.json().catch(() => ({}))) as Parameters<typeof this.toResult>[0];
    if (!j.id) throw new CalendarWriteError('provider_failed', 'google_create_no_id');
    return this.toResult(j);
  }

  async updateEvent(
    calendarId: string,
    token: string,
    providerEventId: string,
    input: Partial<WriteEventInput>,
  ): Promise<WriteEventResult> {
    const res = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.body(input)),
      },
    );
    if (!res.ok) throw new CalendarWriteError('provider_failed', await readError(res));
    const j = (await res.json().catch(() => ({}))) as Parameters<typeof this.toResult>[0];
    return this.toResult({ ...j, id: j.id ?? providerEventId });
  }

  async deleteEvent(calendarId: string, token: string, providerEventId: string): Promise<void> {
    const res = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new CalendarWriteError('provider_failed', await readError(res));
    }
  }

  async updateAttendees(
    calendarId: string,
    token: string,
    providerEventId: string,
    attendees: AttendeeWrite[],
  ): Promise<void> {
    const res = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attendees: attendees.map((a) => ({
            email: a.email,
            displayName: a.name ?? undefined,
            responseStatus: googleResponse(a.responseStatus),
          })),
        }),
      },
    );
    if (!res.ok) throw new CalendarWriteError('provider_failed', await readError(res));
  }
}

export function writerFor(
  provider: CalendarProvider,
  fetchImpl: typeof fetch = fetch,
): ProviderEventWriter {
  return provider === 'microsoft'
    ? new GraphEventWriter(fetchImpl)
    : new GoogleEventWriter(fetchImpl);
}

// ---- Orchestrating service -------------------------------------------

export interface WriteServiceDeps {
  db: Database;
  fetchImpl?: typeof fetch;
}

export interface CreateEventParams {
  firmId: string;
  staffId: string;
  connectionId: string;
  calendarId: string;
  input: WriteEventInput;
  actorAppUserId?: string;
}

export interface UpdateEventParams {
  firmId: string;
  staffId: string;
  /** The calendar_events row id (tb_origin) to update. */
  eventId: string;
  patch: Partial<WriteEventInput>;
  actorAppUserId?: string;
}

export interface DeleteEventParams {
  firmId: string;
  staffId: string;
  eventId: string;
  actorAppUserId?: string;
}

/** A staff connection that can be written to, plus the target calendar. */
export interface WriteTarget {
  connectionId: string;
  calendarId: string;
  provider: CalendarProvider;
}

export class CalendarWriteService {
  ensureEnabled(): void {
    if (!isCalendarWriteEnabled()) throw new Error('calendar_write_disabled');
  }

  /**
   * Resolve where to push an event for `staffId`: their write-scoped
   * connection and a sync-enabled calendar (preferring the primary). Returns
   * null when the staff member has no write-capable connection — callers
   * treat that as "nothing to push" rather than an error.
   */
  async resolveTarget(db: Database, firmId: string, staffId: string): Promise<WriteTarget | null> {
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
    for (const conn of conns) {
      const provider = conn.provider as CalendarProvider;
      if (!hasWriteScope(provider, conn.scope)) continue;
      const sels = await db
        .select()
        .from(staffCalendarSelections)
        .where(
          and(
            eq(staffCalendarSelections.connectionId, conn.id),
            eq(staffCalendarSelections.syncEnabled, true),
          ),
        )
        .orderBy(asc(staffCalendarSelections.createdAt));
      const pick = sels.find((s) => s.isPrimary) ?? sels[0];
      if (pick) {
        return { connectionId: conn.id, calendarId: pick.calendarId, provider };
      }
    }
    return null;
  }

  private async tokenFor(
    db: Database,
    firmId: string,
    connection: ConnectionRow & { provider: string; scope: string | null },
    fetchImpl: typeof fetch,
  ): Promise<{ token: string; provider: CalendarProvider }> {
    const provider = connection.provider as CalendarProvider;
    if (!hasWriteScope(provider, connection.scope)) {
      throw new CalendarWriteError('write_scope_missing');
    }
    const creds = await getProviderCreds(db, firmId, provider);
    if (!creds) throw new CalendarWriteError('not_configured');
    let token: string;
    try {
      token = await ensureFreshAccessToken(db, connection, creds, fetchImpl);
    } catch {
      throw new CalendarWriteError('reauth_required');
    }
    return { token, provider };
  }

  async createEvent(
    deps: WriteServiceDeps,
    params: CreateEventParams,
  ): Promise<{ eventId: string; providerEventId: string; webLink: string | null }> {
    this.ensureEnabled();
    const { db } = deps;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const conn = await loadConnection(db, params.firmId, params.connectionId);
    if (!conn || conn.staffId !== params.staffId || !conn.enabled) {
      throw new CalendarWriteError('not_found');
    }
    const { token, provider } = await this.tokenFor(db, params.firmId, conn, fetchImpl);
    const result = await writerFor(provider, fetchImpl).createEvent(
      params.calendarId,
      token,
      params.input,
    );

    const now = new Date();
    const [row] = await db
      .insert(calendarEvents)
      .values({
        firmId: params.firmId,
        staffId: params.staffId,
        connectionId: conn.id,
        providerEventId: result.providerEventId,
        calendarId: params.calendarId,
        subject: params.input.title,
        startAt: params.input.start,
        endAt: params.input.end,
        location: params.input.location ?? null,
        attendees: (params.input.attendees ?? []).map((email) => ({
          email,
          name: null,
          response_status: null,
        })),
        webLink: result.webLink,
        rawEtag: result.rawEtag,
        tbOrigin: true,
        syncAt: now,
        updatedAt: now,
      })
      .returning({ id: calendarEvents.id });
    if (!row) throw new CalendarWriteError('provider_failed', 'mirror_insert_failed');

    await emitAudit(db, {
      action: 'CREATE',
      entityType: 'calendar_event',
      entityId: row.id,
      actorAppUserId: params.actorAppUserId ?? params.staffId,
      after: { provider, providerEventId: result.providerEventId, subject: params.input.title },
    });

    return { eventId: row.id, providerEventId: result.providerEventId, webLink: result.webLink };
  }

  private async loadOwnedEvent(db: Database, firmId: string, staffId: string, eventId: string) {
    const [ev] = await db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.firmId, firmId)))
      .limit(1);
    if (!ev || !ev.tbOrigin || ev.staffId !== staffId || ev.softDeletedAt) {
      throw new CalendarWriteError('not_found');
    }
    if (!ev.connectionId || !ev.calendarId) throw new CalendarWriteError('not_found');
    return ev;
  }

  async updateEvent(deps: WriteServiceDeps, params: UpdateEventParams): Promise<void> {
    this.ensureEnabled();
    const { db } = deps;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const ev = await this.loadOwnedEvent(db, params.firmId, params.staffId, params.eventId);
    const conn = await loadConnection(db, params.firmId, ev.connectionId!);
    if (!conn) throw new CalendarWriteError('not_found');
    const { token, provider } = await this.tokenFor(db, params.firmId, conn, fetchImpl);
    const result = await writerFor(provider, fetchImpl).updateEvent(
      ev.calendarId!,
      token,
      ev.providerEventId,
      params.patch,
    );

    const now = new Date();
    const set: Record<string, unknown> = { updatedAt: now, syncAt: now, rawEtag: result.rawEtag };
    if (params.patch.title !== undefined) set['subject'] = params.patch.title;
    if (params.patch.start !== undefined) set['startAt'] = params.patch.start;
    if (params.patch.end !== undefined) set['endAt'] = params.patch.end;
    if (params.patch.location !== undefined) set['location'] = params.patch.location ?? null;
    if (params.patch.attendees !== undefined) {
      set['attendees'] = params.patch.attendees.map((email) => ({
        email,
        name: null,
        response_status: null,
      }));
    }
    await db.update(calendarEvents).set(set).where(eq(calendarEvents.id, ev.id));

    await emitAudit(db, {
      action: 'UPDATE',
      entityType: 'calendar_event',
      entityId: ev.id,
      actorAppUserId: params.actorAppUserId ?? params.staffId,
      after: { providerEventId: ev.providerEventId },
    });
  }

  async deleteEvent(deps: WriteServiceDeps, params: DeleteEventParams): Promise<void> {
    this.ensureEnabled();
    const { db } = deps;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const ev = await this.loadOwnedEvent(db, params.firmId, params.staffId, params.eventId);
    const conn = await loadConnection(db, params.firmId, ev.connectionId!);
    if (!conn) throw new CalendarWriteError('not_found');
    const { token, provider } = await this.tokenFor(db, params.firmId, conn, fetchImpl);
    await writerFor(provider, fetchImpl).deleteEvent(ev.calendarId!, token, ev.providerEventId);

    const now = new Date();
    await db
      .update(calendarEvents)
      .set({ softDeletedAt: now, updatedAt: now })
      .where(eq(calendarEvents.id, ev.id));

    await emitAudit(db, {
      action: 'ARCHIVE',
      entityType: 'calendar_event',
      entityId: ev.id,
      actorAppUserId: params.actorAppUserId ?? params.staffId,
      before: { providerEventId: ev.providerEventId },
    });
  }

  /**
   * Push the event's current attendee responses to the provider — used after
   * a client RSVPs. Unlike create/update/delete this works on *ingested*
   * events too (the staff is the organizer), so it does not require
   * tb_origin. Best-effort: returns false (no throw) when write-back can't
   * apply (flag off, no/disabled connection, missing write scope, no creds,
   * stale token, or no attendees). Provider HTTP failures still throw.
   */
  async writeBackAttendees(
    deps: WriteServiceDeps,
    params: { firmId: string; eventId: string },
  ): Promise<boolean> {
    if (!isCalendarWriteEnabled()) return false;
    const { db } = deps;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const [ev] = await db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, params.eventId), eq(calendarEvents.firmId, params.firmId)))
      .limit(1);
    if (!ev || ev.softDeletedAt || !ev.connectionId || !ev.providerEventId || !ev.calendarId) {
      return false;
    }
    const conn = await loadConnection(db, params.firmId, ev.connectionId);
    if (!conn || !conn.enabled) return false;
    const provider = conn.provider as CalendarProvider;
    if (!hasWriteScope(provider, conn.scope)) return false;
    const creds = await getProviderCreds(db, params.firmId, provider);
    if (!creds) return false;
    let token: string;
    try {
      token = await ensureFreshAccessToken(db, conn, creds, fetchImpl);
    } catch {
      return false;
    }
    const attendees: AttendeeWrite[] = (
      (ev.attendees as Array<{
        email?: string | null;
        name?: string | null;
        response_status?: string | null;
      }> | null) ?? []
    )
      .filter((a): a is { email: string; name?: string | null; response_status?: string | null } =>
        Boolean(a.email),
      )
      .map((a) => ({
        email: a.email,
        name: a.name ?? null,
        responseStatus: a.response_status ?? null,
      }));
    if (!attendees.length) return false;
    await writerFor(provider, fetchImpl).updateAttendees(
      ev.calendarId,
      token,
      ev.providerEventId,
      attendees,
    );
    return true;
  }
}
