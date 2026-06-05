// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-3 — the bulk sync tick (runs from the worker heartbeat). Picks every
// enabled connection whose effective interval has elapsed and syncs it,
// isolating failures so one bad connection can't block the rest. Auth
// failures park the connection (no auto-retry); transient transport errors
// bump consecutive_failures and disable after 5.

import { and, eq, isNotNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { staffCalendarConnections } from '@vibe/db/schema';

import { getCalendarSettings } from './settings';
import { syncConnection, SyncHttpError } from './sync';

export interface SyncTickResult {
  scanned: number;
  synced: number;
  events: number;
  deleted: number;
  authFailed: number;
  errors: number;
  skipped: number;
}

const MAX_CONSECUTIVE_FAILURES = 5;

export interface SyncTickLogger {
  warn: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

export async function runCalendarSyncTick(
  db: Database,
  log: SyncTickLogger,
  args: { fetchImpl?: typeof fetch; onNewEvents?: (eventIds: string[]) => Promise<void> } = {},
  now: Date = new Date(),
): Promise<SyncTickResult> {
  const result: SyncTickResult = {
    scanned: 0,
    synced: 0,
    events: 0,
    deleted: 0,
    authFailed: 0,
    errors: 0,
    skipped: 0,
  };

  const connections = await db
    .select()
    .from(staffCalendarConnections)
    .where(
      and(eq(staffCalendarConnections.enabled, true), isNotNull(staffCalendarConnections.staffId)),
    );
  result.scanned = connections.length;

  for (const conn of connections) {
    // Skip parked (auth) connections until the staff re-connects.
    if (conn.syncError === 'auth_failed' || conn.syncError === 'token_expired') {
      result.skipped += 1;
      continue;
    }
    const settings = await getCalendarSettings(db, conn.firmId);
    // Interval gate: only sync if enough time has passed.
    if (
      conn.lastSyncedAt &&
      now.getTime() - conn.lastSyncedAt.getTime() < settings.syncIntervalMinutes * 60_000
    ) {
      result.skipped += 1;
      continue;
    }

    try {
      const outcome = await syncConnection(
        {
          db,
          fetchImpl: args.fetchImpl,
          lookbackDays: settings.lookbackDays,
          lookaheadDays: settings.lookaheadDays,
        },
        conn,
        now,
      );
      if (!outcome.ok) {
        if (outcome.reason === 'auth_failed') result.authFailed += 1;
        else result.errors += 1;
        continue;
      }
      result.synced += 1;
      result.events += outcome.synced;
      result.deleted += outcome.deleted;
      if (outcome.newEventIds.length && args.onNewEvents) {
        await args.onNewEvents(outcome.newEventIds).catch(() => undefined);
      }
    } catch (err) {
      result.errors += 1;
      const failures = (conn.consecutiveFailures ?? 0) + 1;
      const disable = failures >= MAX_CONSECUTIVE_FAILURES;
      const message =
        err instanceof SyncHttpError ? `http_${err.status}` : String((err as Error).message);
      await db
        .update(staffCalendarConnections)
        .set({
          consecutiveFailures: failures,
          syncError: message,
          enabled: disable ? false : conn.enabled,
          updatedAt: now,
        })
        .where(eq(staffCalendarConnections.id, conn.id));
      log.warn({ err, connectionId: conn.id, failures }, 'calendar sync failed');
    }
  }

  return result;
}
