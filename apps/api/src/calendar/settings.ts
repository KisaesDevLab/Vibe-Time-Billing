// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-3 — firm calendar sync settings (interval / lookback / lookahead),
// with sane defaults when no row exists.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { calendarSettings } from '@vibe/db/schema';

export interface CalendarSettings {
  syncIntervalMinutes: number;
  lookbackDays: number;
  lookaheadDays: number;
}

export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  syncIntervalMinutes: 15,
  lookbackDays: 7,
  lookaheadDays: 90,
};

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

export async function getCalendarSettings(db: Database, firmId: string): Promise<CalendarSettings> {
  const [row] = await db
    .select()
    .from(calendarSettings)
    .where(eq(calendarSettings.firmId, firmId))
    .limit(1);
  if (!row) return { ...DEFAULT_CALENDAR_SETTINGS };
  return {
    syncIntervalMinutes: row.syncIntervalMinutes,
    lookbackDays: row.lookbackDays,
    lookaheadDays: row.lookaheadDays,
  };
}

export async function upsertCalendarSettings(
  db: Database,
  firmId: string,
  patch: Partial<CalendarSettings>,
): Promise<CalendarSettings> {
  const current = await getCalendarSettings(db, firmId);
  const next: CalendarSettings = {
    syncIntervalMinutes: clampInt(
      patch.syncIntervalMinutes ?? current.syncIntervalMinutes,
      5,
      60,
      15,
    ),
    lookbackDays: clampInt(patch.lookbackDays ?? current.lookbackDays, 1, 60, 7),
    lookaheadDays: clampInt(patch.lookaheadDays ?? current.lookaheadDays, 7, 365, 90),
  };
  await db
    .insert(calendarSettings)
    .values({ firmId, ...next })
    .onConflictDoUpdate({
      target: calendarSettings.firmId,
      set: { ...next, updatedAt: new Date() },
    });
  return next;
}
