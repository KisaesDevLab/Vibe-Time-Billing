// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Stage 3 — hourly sweep that expires stale client-request time-entry
// suggestions. A suggestion stays pending until the assigned staff
// either accepts (linking a time entry) or dismisses it. Anything
// still pending past its expires_at gets marked dismissed with reason
// 'expired'. The deadline itself was set at suggestion-creation time
// using firm_config.suggestion_expiration_days.

import { and, isNull, lte, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientRequestTimeEntryLinks } from '@vibe/db/schema';

import type { Logger } from 'pino';

export async function runRequestSuggestionSweep(
  db: Database,
  log: Logger,
  now: Date = new Date(),
): Promise<{ expired: number }> {
  const updated = await db
    .update(clientRequestTimeEntryLinks)
    .set({
      dismissedAt: now,
      dismissedReason: 'expired',
    })
    .where(
      and(
        isNull(clientRequestTimeEntryLinks.acceptedAt),
        isNull(clientRequestTimeEntryLinks.dismissedAt),
        lte(clientRequestTimeEntryLinks.expiresAt, now),
      ),
    )
    .returning({ id: clientRequestTimeEntryLinks.id });
  if (updated.length > 0) {
    log.info({ count: updated.length }, 'expired client-request suggestions');
  }
  // Suppress unused-import warning for `sql` — kept available for
  // future queries that need a count or where clause.
  void sql;
  return { expired: updated.length };
}
