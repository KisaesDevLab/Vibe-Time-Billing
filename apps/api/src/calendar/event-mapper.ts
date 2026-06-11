// SPDX-License-Identifier: Elastic-2.0
//
// CAL-3 — normalize a provider event (Microsoft Graph or Google Calendar)
// into our calendar_events column shape. Pure + unit-tested; the network +
// pagination live in sync.ts. Recurring series are NOT expanded here (each
// occurrence the provider returns is treated independently — series-aware
// handling is a deferred v2 item).

import type { CalendarProvider } from './oauth';

export interface NormalizedAttendee {
  email: string | null;
  name: string | null;
  response_status: string | null;
}

export interface NormalizedEvent {
  providerEventId: string;
  subject: string | null;
  bodyPreview: string | null;
  startAt: Date | null;
  endAt: Date | null;
  location: string | null;
  isAllDay: boolean;
  organizerEmail: string | null;
  organizerName: string | null;
  attendees: NormalizedAttendee[];
  icalUid: string | null;
  webLink: string | null;
  rawEtag: string | null;
  /** Google tombstones (status === 'cancelled') flag a deletion. */
  deleted: boolean;
}

// ---- Microsoft Graph -------------------------------------------------

interface GraphDateTime {
  dateTime?: string;
  timeZone?: string;
}
export interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: GraphDateTime;
  end?: GraphDateTime;
  location?: { displayName?: string };
  isAllDay?: boolean;
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: Array<{
    emailAddress?: { name?: string; address?: string };
    status?: { response?: string };
  }>;
  iCalUId?: string;
  webLink?: string;
  '@odata.etag'?: string;
}

// Graph returns naive datetimes in the requested zone; we request UTC via
// the `Prefer: outlook.timezone="UTC"` header, so append Z when missing.
function parseGraphDate(d: GraphDateTime | undefined): Date | null {
  if (!d?.dateTime) return null;
  const s = d.dateTime;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export function mapGraphEvent(e: GraphEvent): NormalizedEvent {
  return {
    providerEventId: e.id,
    subject: e.subject ?? null,
    bodyPreview: e.bodyPreview ?? null,
    startAt: parseGraphDate(e.start),
    endAt: parseGraphDate(e.end),
    location: e.location?.displayName ?? null,
    isAllDay: Boolean(e.isAllDay),
    organizerEmail: e.organizer?.emailAddress?.address ?? null,
    organizerName: e.organizer?.emailAddress?.name ?? null,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.emailAddress?.address ?? null,
      name: a.emailAddress?.name ?? null,
      response_status: a.status?.response ?? null,
    })),
    icalUid: e.iCalUId ?? null,
    webLink: e.webLink ?? null,
    rawEtag: e['@odata.etag'] ?? null,
    deleted: false,
  };
}

// ---- Google Calendar -------------------------------------------------

interface GoogleDateTime {
  dateTime?: string;
  date?: string; // all-day
}
export interface GoogleEvent {
  id: string;
  status?: string; // 'cancelled' = tombstone
  summary?: string;
  description?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  location?: string;
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
  iCalUID?: string;
  htmlLink?: string;
  etag?: string;
}

function parseGoogleDate(d: GoogleDateTime | undefined): Date | null {
  const s = d?.dateTime ?? d?.date;
  if (!s) return null;
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export function mapGoogleEvent(e: GoogleEvent): NormalizedEvent {
  return {
    providerEventId: e.id,
    subject: e.summary ?? null,
    bodyPreview: e.description ? e.description.slice(0, 500) : null,
    startAt: parseGoogleDate(e.start),
    endAt: parseGoogleDate(e.end),
    location: e.location ?? null,
    isAllDay: Boolean(e.start?.date && !e.start?.dateTime),
    organizerEmail: e.organizer?.email ?? null,
    organizerName: e.organizer?.displayName ?? null,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email ?? null,
      name: a.displayName ?? null,
      response_status: a.responseStatus ?? null,
    })),
    icalUid: e.iCalUID ?? null,
    webLink: e.htmlLink ?? null,
    rawEtag: e.etag ?? null,
    deleted: e.status === 'cancelled',
  };
}

export function mapEvent(provider: CalendarProvider, raw: unknown): NormalizedEvent {
  return provider === 'microsoft'
    ? mapGraphEvent(raw as GraphEvent)
    : mapGoogleEvent(raw as GoogleEvent);
}
