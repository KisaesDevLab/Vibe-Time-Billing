// SPDX-License-Identifier: Elastic-2.0
//
// Rollforward date-mapping engine. Two modes:
//   DEADLINE  — anchor to the filing deadline, preserving the signed whole-week
//               offset AND the ISO weekday (keeps "2 weeks before 4/15, on a
//               Tuesday" stable even though 4/15's weekday moves year to year).
//   ISO_WEEK  — same ISO week number + same ISO weekday in the target week-year
//               (pure same-week-number behaviour), with a 53→52 fallback.
// Dates only (YYYY-MM-DD); the caller layers time-of-day/timezone back on for
// appointments. Uses Luxon for ISO-week + weekday math (no hand-rolling).

import { DateTime } from 'luxon';

import { deadlineSpecFor, type MonthDay } from './deadlines';

export type MappingMode = 'DEADLINE' | 'ISO_WEEK';

const ZONE = 'utc';

function parse(sourceDate: string): DateTime {
  return DateTime.fromISO(sourceDate, { zone: ZONE });
}

// The deadline (filing vs extension) the source date is nearest to, in the
// source date's calendar year.
function relevantDeadline(d: DateTime, returnType: string | null | undefined): MonthDay | null {
  const spec = deadlineSpecFor(returnType);
  if (!spec) return null;
  const candidates = [spec.filing, spec.extension];
  let best: MonthDay = spec.filing;
  let bestDist = Infinity;
  for (const md of candidates) {
    const anchor = DateTime.fromObject(
      { year: d.year, month: md.month, day: md.day },
      { zone: ZONE },
    );
    const dist = Math.abs(anchor.diff(d, 'days').days);
    if (dist < bestDist) {
      bestDist = dist;
      best = md;
    }
  }
  return best;
}

/**
 * ISO-week-anchored: same ISO week number + ISO weekday in the target week-year.
 * If the target week-year has only 52 weeks but the source was week 53, fall
 * back to week 52 (same weekday).
 */
export function mapIsoWeek(sourceDate: string, targetYear: number): string {
  const d = parse(sourceDate);
  const maxWeeks = DateTime.fromObject({ weekYear: targetYear }, { zone: ZONE }).weeksInWeekYear;
  const weekNumber = Math.min(d.weekNumber, maxWeeks);
  // Monday of the target ISO week, then offset to the source's ISO weekday.
  const weekStart = DateTime.fromObject({ weekYear: targetYear, weekNumber }, { zone: ZONE });
  return weekStart.plus({ days: d.weekday - 1 }).toISODate()!;
}

/**
 * Deadline-anchored, weekday-preserving. Returns the target-year date that is
 * the same signed number of whole weeks from the (same) filing deadline and the
 * same ISO weekday as the source date. Falls back to ISO-week mapping when the
 * return type has no known deadline.
 */
export function mapDeadlineAnchored(
  sourceDate: string,
  returnType: string | null | undefined,
  targetYear: number,
): string {
  const d = parse(sourceDate);
  const md = relevantDeadline(d, returnType);
  if (!md) return mapIsoWeek(sourceDate, targetYear);

  const aSrc = DateTime.fromObject({ year: d.year, month: md.month, day: md.day }, { zone: ZONE });
  const aTgt = DateTime.fromObject(
    { year: targetYear, month: md.month, day: md.day },
    { zone: ZONE },
  );

  // Whole-week offset between the Monday of D's ISO week and the Monday of the
  // deadline's ISO week (Luxon weeks are ISO — Monday start).
  const weekOffset = Math.round(d.startOf('week').diff(aSrc.startOf('week'), 'weeks').weeks);
  const targetMonday = aTgt.startOf('week').plus({ weeks: weekOffset });
  const target = targetMonday.plus({ days: d.weekday - 1 });
  return target.toISODate()!;
}

/** Mode dispatcher used by the rollforward services. */
export function mapDate(opts: {
  sourceDate: string; // YYYY-MM-DD
  returnType: string | null | undefined;
  targetYear: number;
  mode: MappingMode;
}): string {
  return opts.mode === 'ISO_WEEK'
    ? mapIsoWeek(opts.sourceDate, opts.targetYear)
    : mapDeadlineAnchored(opts.sourceDate, opts.returnType, opts.targetYear);
}

/**
 * Map a full instant (an appointment's start) to the target year, preserving
 * the local wall-clock time-of-day in the firm timezone (DST-correct via
 * Luxon). Returns a UTC ISO string. The date is moved by the same rule as
 * mapDate; only the calendar date changes, not the time-of-day.
 */
export function mapDateTime(opts: {
  sourceUtcISO: string;
  returnType: string | null | undefined;
  targetYear: number;
  mode: MappingMode;
  zone: string; // firm timezone, e.g. America/Chicago
}): string {
  const src = DateTime.fromISO(opts.sourceUtcISO, { zone: 'utc' }).setZone(opts.zone);
  const targetDate = mapDate({
    sourceDate: src.toISODate()!,
    returnType: opts.returnType,
    targetYear: opts.targetYear,
    mode: opts.mode,
  });
  const [y, m, d] = targetDate.split('-').map(Number) as [number, number, number];
  return DateTime.fromObject(
    { year: y, month: m, day: d, hour: src.hour, minute: src.minute, second: src.second },
    { zone: opts.zone },
  )
    .toUTC()
    .toISO()!;
}
