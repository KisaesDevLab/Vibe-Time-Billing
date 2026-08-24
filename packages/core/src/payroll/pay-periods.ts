// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Pay-period generation. WEEKLY/BIWEEKLY tile forward and backward from
// an anchor period-start date; SEMI_MONTHLY is fixed 1–15 / 16–EOM;
// MONTHLY is the calendar month (anchor unused for those two).

import type { IsoDate } from '@vibe/types';

import { addDays, dayOf, diffDays, lastDayOfMonth, monthOf, yearOf } from './dates';

export type PayPeriodFrequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMI_MONTHLY' | 'MONTHLY';

export interface PeriodRange {
  start: IsoDate;
  end: IsoDate;
}

// Monday 1970-01-05 — used only when a WEEKLY/BIWEEKLY firm has not set
// payroll_period_anchor_date yet; keeps the math total instead of throwing.
export const FALLBACK_ANCHOR: IsoDate = '1970-01-05';

function periodContaining(
  frequency: PayPeriodFrequency,
  anchor: IsoDate | null,
  date: IsoDate,
): PeriodRange {
  switch (frequency) {
    case 'WEEKLY':
    case 'BIWEEKLY': {
      const len = frequency === 'WEEKLY' ? 7 : 14;
      const a = anchor ?? FALLBACK_ANCHOR;
      const k = Math.floor(diffDays(a, date) / len);
      const start = addDays(a, k * len);
      return { start, end: addDays(start, len - 1) };
    }
    case 'SEMI_MONTHLY': {
      const y = yearOf(date);
      const m = monthOf(date);
      const mm = String(m).padStart(2, '0');
      if (dayOf(date) <= 15) {
        return { start: `${y}-${mm}-01`, end: `${y}-${mm}-15` };
      }
      return { start: `${y}-${mm}-16`, end: lastDayOfMonth(y, m) };
    }
    case 'MONTHLY': {
      const y = yearOf(date);
      const m = monthOf(date);
      const mm = String(m).padStart(2, '0');
      return { start: `${y}-${mm}-01`, end: lastDayOfMonth(y, m) };
    }
  }
}

export function payPeriodForDate(
  frequency: PayPeriodFrequency,
  anchor: IsoDate | null,
  date: IsoDate,
): PeriodRange {
  return periodContaining(frequency, anchor, date);
}

/** Every period overlapping [fromDate, toDate], in order. */
export function generatePayPeriods(
  frequency: PayPeriodFrequency,
  anchor: IsoDate | null,
  fromDate: IsoDate,
  toDate: IsoDate,
): PeriodRange[] {
  const periods: PeriodRange[] = [];
  let cur = periodContaining(frequency, anchor, fromDate);
  while (cur.start <= toDate) {
    periods.push(cur);
    cur = periodContaining(frequency, anchor, addDays(cur.end, 1));
  }
  return periods;
}

/**
 * Workweeks (7-day spans starting on workweekStartDay) whose LAST day
 * falls inside [start, end] — the weeks whose OT is attributed to that
 * period (full OT to the period in which the workweek ends).
 */
export function workweeksEndingInRange(
  start: IsoDate,
  end: IsoDate,
  workweekStartDay: number,
): PeriodRange[] {
  const weeks: PeriodRange[] = [];
  // Earliest workweek that could end in range starts up to 6 days before.
  let ws = workweekStartFor(start, workweekStartDay);
  for (; ; ws = addDays(ws, 7)) {
    const we = addDays(ws, 6);
    if (we > end) break;
    if (we >= start) weeks.push({ start: ws, end: we });
  }
  return weeks;
}

/** Start of the workweek containing `date`. */
export function workweekStartFor(date: IsoDate, workweekStartDay: number): IsoDate {
  const dow = new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
  const back = (dow - workweekStartDay + 7) % 7;
  return addDays(date, -back);
}
