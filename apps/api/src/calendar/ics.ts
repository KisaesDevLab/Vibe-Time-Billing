// SPDX-License-Identifier: Elastic-2.0
//
// CAL-6 — minimal RFC 5545 .ics builder for "Add to calendar". Hand-rolled
// (no extra dependency); covers the fields a single appointment needs.

export interface IcsAttendee {
  email: string;
  name?: string | null;
}

export interface IcsEvent {
  uid: string;
  title: string | null;
  start: Date | null;
  end: Date | null;
  location?: string | null;
  description?: string | null;
  organizerName?: string | null;
  /** BK-6 — organizer mailbox; defaults to a noreply placeholder. */
  organizerEmail?: string | null;
  /** BK-6 — invited attendees (staff + client contacts). */
  attendees?: IcsAttendee[];
  /** Cancellation .ics uses METHOD:CANCEL + STATUS:CANCELLED. */
  method?: 'PUBLISH' | 'CANCEL';
  status?: 'CONFIRMED' | 'CANCELLED';
}

function fmt(d: Date): string {
  // UTC basic format: YYYYMMDDTHHMMSSZ
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function fold(line: string): string {
  // RFC 5545 lines SHOULD be ≤75 octets; fold with CRLF + space.
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 74) {
    parts.push(' ' + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest.length) parts.push(' ' + rest);
  return parts.join('\r\n');
}

export function buildIcs(event: IcsEvent, now: Date = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vibe Time & Billing//Calendar//EN',
    `METHOD:${event.method ?? 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${fmt(now)}`,
  ];
  if (event.start) lines.push(`DTSTART:${fmt(event.start)}`);
  if (event.end) lines.push(`DTEND:${fmt(event.end)}`);
  if (event.title) lines.push(`SUMMARY:${escape(event.title)}`);
  if (event.location) lines.push(`LOCATION:${escape(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escape(event.description)}`);
  const organizerMail = event.organizerEmail ?? 'noreply';
  if (event.organizerName || event.organizerEmail) {
    const cn = event.organizerName ? `;CN=${escape(event.organizerName)}` : '';
    lines.push(`ORGANIZER${cn}:mailto:${organizerMail}`);
  }
  for (const a of event.attendees ?? []) {
    const cn = a.name ? `;CN=${escape(a.name)}` : '';
    lines.push(`ATTENDEE${cn};RSVP=TRUE:mailto:${a.email}`);
  }
  if (event.status) lines.push(`STATUS:${event.status}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
