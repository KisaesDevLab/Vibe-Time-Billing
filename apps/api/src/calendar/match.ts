// SPDX-License-Identifier: Elastic-2.0
//
// CAL-4 — run matching for one event and persist the result. Idempotent: an
// event with a confirmed match is left alone; otherwise its non-confirmed
// match rows are replaced with the freshly-computed candidate(s).

import { and, eq, isNotNull, ne } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  calendarEventMatches,
  calendarEvents,
  clientContacts,
  clients,
  persons,
} from '@vibe/db/schema';

import { matchEvent, type EventForMatch } from './matcher';

export interface MatchRunResult {
  status: 'skipped_confirmed' | 'matched' | 'unmatched' | 'event_missing';
  tier?: string;
  candidates?: number;
}

export async function runCalendarMatch(
  db: Database,
  eventId: string,
  now: Date = new Date(),
): Promise<MatchRunResult> {
  const [event] = await db
    .select({
      id: calendarEvents.id,
      firmId: calendarEvents.firmId,
      subject: calendarEvents.subject,
      organizerEmail: calendarEvents.organizerEmail,
      attendees: calendarEvents.attendees,
    })
    .from(calendarEvents)
    .where(eq(calendarEvents.id, eventId))
    .limit(1);
  if (!event) return { status: 'event_missing' };

  // Idempotent: never override a confirmed match.
  const existing = await db
    .select({ status: calendarEventMatches.matchStatus })
    .from(calendarEventMatches)
    .where(eq(calendarEventMatches.eventId, eventId));
  if (existing.some((m) => m.status === 'confirmed')) {
    return { status: 'skipped_confirmed' };
  }

  const [clientRows, contactRows] = await Promise.all([
    db
      .select({ id: clients.id, name: clients.name, clientFacingName: clients.clientFacingName })
      .from(clients)
      .where(and(eq(clients.firmId, event.firmId), eq(clients.status, 'ACTIVE'))),
    db
      // 0115 — contact email is canonical on person.
      .select({ clientId: clientContacts.clientId, email: persons.email })
      .from(clientContacts)
      .innerJoin(clients, eq(clients.id, clientContacts.clientId))
      .innerJoin(persons, eq(persons.id, clientContacts.personId))
      .where(and(eq(clients.firmId, event.firmId), isNotNull(persons.email))),
  ]);

  const result = matchEvent(
    {
      subject: event.subject,
      organizerEmail: event.organizerEmail,
      attendees: (event.attendees as EventForMatch['attendees']) ?? [],
    },
    clientRows,
    contactRows,
  );

  await db.transaction(async (tx) => {
    // Replace any prior non-confirmed rows for this event.
    await tx
      .delete(calendarEventMatches)
      .where(
        and(
          eq(calendarEventMatches.eventId, eventId),
          ne(calendarEventMatches.matchStatus, 'confirmed'),
        ),
      );
    await tx.insert(calendarEventMatches).values(
      result.candidates.map((c) => ({
        eventId,
        clientId: c.clientId,
        matchTier: result.tier,
        matchScore: c.score,
        matchStatus: c.status,
        matchedBy: null,
        matchedAt: c.status === 'confirmed' ? now : null,
      })),
    );
  });

  return {
    status: result.tier === 'unmatched' ? 'unmatched' : 'matched',
    tier: result.tier,
    candidates: result.candidates.length,
  };
}
