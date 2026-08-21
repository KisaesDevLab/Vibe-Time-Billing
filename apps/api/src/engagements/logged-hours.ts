// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared "hours actually logged on an engagement" aggregate — the basis
// for budget-from-actuals when an engagement rolls over (0202 introduced
// this in recurrence-spawn; 0221 extracts it so the manual /rollover,
// the duplicate-engagement action, and the rollforward batch all agree).
//
// Status set intentionally includes WRITTEN_OFF: written-off time was
// still EFFORT the next budget should anticipate, even though it wasn't
// billed. (The engagement budget widget's utilization view excludes it —
// different question, different filter.)

import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { timeEntries } from '@vibe/db/schema';

// Accept a live transaction too — callers inside db.transaction() must
// query through the tx handle (pglite tests are single-connection; an
// outer-db read mid-transaction deadlocks).
type TxOrDb = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export const LOGGED_HOURS_STATUSES = ['SUBMITTED', 'LOCKED', 'BILLED', 'WRITTEN_OFF'] as const;

export interface LoggedEffort {
  /** Total hours across counted statuses (0 when none). */
  hours: number;
  /** Sum of hours × cost-rate snapshot, in cents (0 when none). */
  costCents: number;
}

export async function sumLoggedEffort(db: TxOrDb, engagementId: string): Promise<LoggedEffort> {
  const [agg] = await db
    .select({
      hours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
      costCents: sql<string>`COALESCE(SUM(${timeEntries.hours} * COALESCE(${timeEntries.costRateSnapshotCents}, 0)), 0)`,
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.engagementId, engagementId),
        inArray(timeEntries.status, [...LOGGED_HOURS_STATUSES]),
      ),
    );
  return {
    hours: Number(agg?.hours ?? 0),
    costCents: Math.round(Number(agg?.costCents ?? 0)),
  };
}

/** Budget hours for a successor engagement: prior actuals when any time
 *  was logged, else the fallback (the old budget / template default). */
export async function budgetHoursFromActuals(
  db: TxOrDb,
  previousEngagementId: string,
  fallback: string | null,
): Promise<string | null> {
  const { hours } = await sumLoggedEffort(db, previousEngagementId);
  return hours > 0 ? hours.toFixed(2) : fallback;
}
