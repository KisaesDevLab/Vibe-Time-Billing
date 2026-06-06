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
  /** Minutes-before-start reminder offsets (e.g. [1440, 120]). */
  reminderOffsetsMinutes: number[];
  /** 0121 — quiet hours for SMS/voice reminders (HH:MM, firm/office tz). */
  reminderQuietStart: string;
  reminderQuietEnd: string;
}

export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  syncIntervalMinutes: 15,
  lookbackDays: 7,
  lookaheadDays: 90,
  reminderOffsetsMinutes: [1440, 120],
  reminderQuietStart: '08:00',
  reminderQuietEnd: '20:00',
};

const ALLOWED_OFFSETS = new Set([10080, 4320, 1440, 120]); // 7d, 3d, 1d, 2h
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function validHHMM(v: string | undefined, fallback: string): string {
  return v && HHMM_RE.test(v) ? v : fallback;
}

export async function getCalendarSettings(db: Database, firmId: string): Promise<CalendarSettings> {
  const [row] = await db
    .select()
    .from(calendarSettings)
    .where(eq(calendarSettings.firmId, firmId))
    .limit(1);
  if (!row) return { ...DEFAULT_CALENDAR_SETTINGS };
  const offsets = Array.isArray(row.reminderOffsetsMinutes)
    ? (row.reminderOffsetsMinutes as number[])
    : DEFAULT_CALENDAR_SETTINGS.reminderOffsetsMinutes;
  return {
    syncIntervalMinutes: row.syncIntervalMinutes,
    lookbackDays: row.lookbackDays,
    lookaheadDays: row.lookaheadDays,
    reminderOffsetsMinutes: offsets,
    reminderQuietStart: validHHMM(row.reminderQuietStart, '08:00'),
    reminderQuietEnd: validHHMM(row.reminderQuietEnd, '20:00'),
  };
}

export async function upsertCalendarSettings(
  db: Database,
  firmId: string,
  patch: Partial<CalendarSettings>,
): Promise<CalendarSettings> {
  const current = await getCalendarSettings(db, firmId);
  const offsets = (patch.reminderOffsetsMinutes ?? current.reminderOffsetsMinutes)
    .filter((n) => ALLOWED_OFFSETS.has(n))
    .sort((a, b) => b - a);
  const next: CalendarSettings = {
    syncIntervalMinutes: clampInt(
      patch.syncIntervalMinutes ?? current.syncIntervalMinutes,
      5,
      60,
      15,
    ),
    lookbackDays: clampInt(patch.lookbackDays ?? current.lookbackDays, 1, 60, 7),
    lookaheadDays: clampInt(patch.lookaheadDays ?? current.lookaheadDays, 7, 365, 90),
    reminderOffsetsMinutes: offsets.length ? offsets : current.reminderOffsetsMinutes,
    reminderQuietStart: validHHMM(
      patch.reminderQuietStart ?? current.reminderQuietStart,
      current.reminderQuietStart,
    ),
    reminderQuietEnd: validHHMM(
      patch.reminderQuietEnd ?? current.reminderQuietEnd,
      current.reminderQuietEnd,
    ),
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
