// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Weekly-over-40 overtime (FLSA) for non-exempt staff, and the
// period-total attribution rule: a workweek's OT belongs in full to the
// pay period in which the workweek ENDS (standard payroll practice; no
// pro-ration). A period's Regular is its in-period worked hours minus
// the OT attributed to it, clamped at 0 for the rare straddle where a
// workweek's hours land mostly in the prior period.

import type { IsoDate } from '@vibe/types';

import { round2 } from './dates';
import { type PeriodRange, workweekStartFor, workweeksEndingInRange } from './pay-periods';
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

export interface PeriodAttributionInput {
  period: PeriodRange;
  /**
   * Worked (REGULAR) hours per day. Must cover every workweek that ends
   * inside the period — i.e. start at least 6 days before period.start —
   * or straddling weeks under-count their OT.
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
  /** OT of workweeks ending inside the period. Always 0 for exempt. */
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

  const weeks = computeWeeklyOvertime(dailyWorkedHours, workweekStartDay);
  const ending = new Set(
    workweeksEndingInRange(period.start, period.end, workweekStartDay).map((w) => w.start),
  );
  const otHours = round2(
    weeks.filter((w) => ending.has(w.start)).reduce((sum, w) => sum + w.otHours, 0),
  );
  return {
    actualWorkedHours,
    regularHours: round2(Math.max(0, actualWorkedHours - otHours)),
    otHours,
  };
}
