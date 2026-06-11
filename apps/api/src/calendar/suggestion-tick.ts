// SPDX-License-Identifier: Elastic-2.0
//
// CAL-8 — when a confirmed appointment has just ended, queue a one-time
// "log your time?" suggestion for its staff member. Idempotent via the
// unique (event_id) on the suggestion log.

import { and, eq, gt, isNotNull, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { calendarEventMatches, calendarEvents, staffTimeSuggestionLog } from '@vibe/db/schema';

export interface SuggestionTickResult {
  scanned: number;
  created: number;
}

export async function runCalendarSuggestionTick(
  db: Database,
  now: Date = new Date(),
): Promise<SuggestionTickResult> {
  const result: SuggestionTickResult = { scanned: 0, created: 0 };
  const windowStart = new Date(now.getTime() - 30 * 60_000);

  // Confirmed-match events that ended in the last 30 minutes, with a staff
  // owner + client, that don't yet have a suggestion.
  const ended = await db
    .select({
      id: calendarEvents.id,
      staffId: calendarEvents.staffId,
    })
    .from(calendarEvents)
    .innerJoin(calendarEventMatches, eq(calendarEventMatches.eventId, calendarEvents.id))
    .where(
      and(
        eq(calendarEventMatches.matchStatus, 'confirmed'),
        isNotNull(calendarEventMatches.clientId),
        isNotNull(calendarEvents.staffId),
        gt(calendarEvents.endAt, windowStart),
        lte(calendarEvents.endAt, now),
      ),
    )
    .limit(500);
  result.scanned = ended.length;

  for (const ev of ended) {
    if (!ev.staffId) continue;
    const inserted = await db
      .insert(staffTimeSuggestionLog)
      .values({ eventId: ev.id, staffId: ev.staffId, action: 'pending' })
      .onConflictDoNothing({ target: staffTimeSuggestionLog.eventId })
      .returning({ id: staffTimeSuggestionLog.id });
    if (inserted.length) result.created += 1;
  }
  return result;
}
