// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-6 — minimal RFC 5545 .ics builder for "Add to calendar". Hand-rolled
// (no extra dependency); covers the fields a single appointment needs.

export interface IcsEvent {
  uid: string;
  title: string | null;
  start: Date | null;
  end: Date | null;
  location?: string | null;
  description?: string | null;
  organizerName?: string | null;
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
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${fmt(now)}`,
  ];
  if (event.start) lines.push(`DTSTART:${fmt(event.start)}`);
  if (event.end) lines.push(`DTEND:${fmt(event.end)}`);
  if (event.title) lines.push(`SUMMARY:${escape(event.title)}`);
  if (event.location) lines.push(`LOCATION:${escape(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escape(event.description)}`);
  if (event.organizerName) lines.push(`ORGANIZER;CN=${escape(event.organizerName)}:mailto:noreply`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
