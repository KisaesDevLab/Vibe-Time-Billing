// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-2 — shared bits for the connect flow: the OAuth `state` store
// (Redis-backed in prod, injectable in tests), the redirect-URI builder,
// and the calendar-list upsert used after connect + on refresh.

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { staffCalendarSelections } from '@vibe/db/schema';

import type { CalendarProvider, ProviderCalendar } from './oauth';

/** syncError marker: tokens are fine but the provider calendar list
 *  couldn't be fetched (connect callback or refresh-calendars route).
 *  Recoverable via "Refresh calendars" — distinct from token_expired. */
export const SYNC_ERROR_CALENDAR_LIST_FAILED = 'calendar_list_failed';

/** Short-lived store for the OAuth state nonce (10-min TTL). */
export interface OAuthStateStore {
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

export interface OAuthStatePayload {
  staffId: string;
  firmId: string;
  provider: CalendarProvider;
}

export function newState(): string {
  return randomUUID();
}

export function stateKey(state: string): string {
  return `cal:oauth:state:${state}`;
}

export function callbackRedirectUri(base: string, provider: CalendarProvider): string {
  return `${base.replace(/\/$/, '')}/api/calendar/oauth/callback/${provider}`;
}

/**
 * Upsert a connection's calendar list. New calendars are added (primary
 * pre-enabled), and any selection no longer returned by the provider is
 * marked sync_enabled = false (kept for history).
 */
export async function upsertCalendarList(
  db: Database,
  connectionId: string,
  calendars: ProviderCalendar[],
): Promise<void> {
  const seen = calendars.map((c) => c.calendarId);
  for (const c of calendars) {
    const [existing] = await db
      .select({ id: staffCalendarSelections.id })
      .from(staffCalendarSelections)
      .where(
        and(
          eq(staffCalendarSelections.connectionId, connectionId),
          eq(staffCalendarSelections.calendarId, c.calendarId),
        ),
      )
      .limit(1);
    if (existing) {
      await db
        .update(staffCalendarSelections)
        .set({
          calendarName: c.name,
          color: c.color,
          isPrimary: c.isPrimary,
          updatedAt: new Date(),
        })
        .where(eq(staffCalendarSelections.id, existing.id));
    } else {
      await db.insert(staffCalendarSelections).values({
        connectionId,
        calendarId: c.calendarId,
        calendarName: c.name,
        color: c.color,
        isPrimary: c.isPrimary,
        // Pre-enable the primary calendar; others opt-in.
        syncEnabled: c.isPrimary,
      });
    }
  }
  // Disable selections the provider no longer returns.
  const all = await db
    .select({ id: staffCalendarSelections.id, calendarId: staffCalendarSelections.calendarId })
    .from(staffCalendarSelections)
    .where(eq(staffCalendarSelections.connectionId, connectionId));
  const stale = all.filter((s) => !seen.includes(s.calendarId)).map((s) => s.id);
  if (stale.length > 0) {
    await db
      .update(staffCalendarSelections)
      .set({ syncEnabled: false, updatedAt: new Date() })
      .where(inArray(staffCalendarSelections.id, stale));
  }
}
