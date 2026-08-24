// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Weekly-over-40 overtime (FLSA) for non-exempt staff. OT hours are the
// chronological TAIL of the workweek — the hours worked after the week's
// cumulative total crosses 40 — and each OT hour is attributed to the
// pay period containing the day it was actually worked. This keeps
// regular + OT across periods exactly equal to hours worked even when a
// workweek straddles a period boundary (a week-end attribution would pay
// the straddling hours once at 1.0x in the earlier period and again at
// 1.5x in the later one). Payroll for a period is run after the period
// ends, by which point any straddling week is complete, so the split is
// computable at review time.

import type { IsoDate } from '@vibe/types';

import { round2 } from './dates';
import { type PeriodRange, workweekStartFor } from './pay-periods';
import type { PayPeriodFrequency } from './pay-periods';

export const OT_WEEKLY_THRESHOLD = 40;

export interface WorkweekTotals extends PeriodRange {
  workedHours: number;
  otHours: number;
}

/** Bucket worked hours (payroll_category REGULAR only) into workweeks. */
export function computeWeeklyOvertime(
  dailyWorkedHours: Record<IsoDate, number>,
  workweekStartDay: number,
): WorkweekTotals[] {
  const byWeek = new Map<IsoDate, number>();
  for (const [day, hours] of Object.entries(dailyWorkedHours)) {
    if (!hours) continue;
    const ws = workweekStartFor(day, workweekStartDay);
    byWeek.set(ws, (byWeek.get(ws) ?? 0) + hours);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([start, worked]) => {
      const end = addDays6(start);
      const workedHours = round2(worked);
      return {
        start,
        end,
        workedHours,
        otHours: round2(Math.max(0, workedHours - OT_WEEKLY_THRESHOLD)),
      };
    });
}

function addDays6(start: IsoDate): IsoDate {
  const t = Date.parse(`${start}T00:00:00Z`) + 6 * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Per-day OT hours: walk each workweek's days in date order, accumulate
 * worked hours, and mark the portion of each day past the 40h cumulative
 * threshold as OT. A day's OT never exceeds its worked hours, so
 * (worked − OT) per period can never go negative.
 */
export function computeDailyOtHours(
  dailyWorkedHours: Record<IsoDate, number>,
  workweekStartDay: number,
): Record<IsoDate, number> {
  const byWeek = new Map<IsoDate, Array<[IsoDate, number]>>();
  for (const [day, hours] of Object.entries(dailyWorkedHours)) {
    if (!hours) continue;
    const ws = workweekStartFor(day, workweekStartDay);
    const list = byWeek.get(ws) ?? [];
    list.push([day, hours]);
    byWeek.set(ws, list);
  }
  const otByDay: Record<IsoDate, number> = {};
  for (const days of byWeek.values()) {
    days.sort(([a], [b]) => (a < b ? -1 : 1));
    let cum = 0;
    for (const [day, hours] of days) {
      const before = cum;
      cum += hours;
      const ot = Math.min(hours, Math.max(0, cum - Math.max(OT_WEEKLY_THRESHOLD, before)));
      if (ot > 0) otByDay[day] = round2(ot);
    }
  }
  return otByDay;
}

export interface PeriodAttributionInput {
  period: PeriodRange;
  /**
   * Worked (REGULAR) hours per day. Must cover every workweek that
   * OVERLAPS the period — i.e. span from 6 days before period.start to
   * 6 days after period.end — or straddling weeks under-count their OT.
   */
  dailyWorkedHours: Record<IsoDate, number>;
  workweekStartDay: number;
  overtimeExempt: boolean;
  standardHoursPerWeek: number;
  frequency: PayPeriodFrequency;
}

export interface PeriodTotals {
  /** Hours actually logged with REGULAR codes inside the period. */
  actualWorkedHours: number;
  /** Pay-basis regular hours (exempt: standard; non-exempt: worked − OT). */
  regularHours: number;
  /** OT hours worked on days inside the period. Always 0 for exempt. */
  otHours: number;
}

/** Standard hours prorated to one period of the given frequency. */
export function standardHoursForPeriod(
  standardHoursPerWeek: number,
  frequency: PayPeriodFrequency,
): number {
  switch (frequency) {
    case 'WEEKLY':
      return round2(standardHoursPerWeek);
    case 'BIWEEKLY':
      return round2(standardHoursPerWeek * 2);
    case 'SEMI_MONTHLY':
      return round2((standardHoursPerWeek * 52) / 24);
    case 'MONTHLY':
      return round2((standardHoursPerWeek * 52) / 12);
  }
}

export function attributePeriodTotals(input: PeriodAttributionInput): PeriodTotals {
  const { period, dailyWorkedHours, workweekStartDay } = input;
  const actualWorkedHours = round2(
    Object.entries(dailyWorkedHours)
      .filter(([d]) => d >= period.start && d <= period.end)
      .reduce((sum, [, h]) => sum + h, 0),
  );

  if (input.overtimeExempt) {
    return {
      actualWorkedHours,
      regularHours: standardHoursForPeriod(input.standardHoursPerWeek, input.frequency),
      otHours: 0,
    };
  }

  const otByDay = computeDailyOtHours(dailyWorkedHours, workweekStartDay);
  const otHours = round2(
    Object.entries(otByDay)
      .filter(([d]) => d >= period.start && d <= period.end)
      .reduce((sum, [, h]) => sum + h, 0),
  );
  return {
    actualWorkedHours,
    regularHours: round2(actualWorkedHours - otHours),
    otHours,
  };
}
