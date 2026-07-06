// SPDX-License-Identifier: Elastic-2.0
//
// Recurring billing core. Pure-function next-run computation, proration,
// and hour-bank balance computation. Worker scheduling sits on top
// (apps/worker), invoking these per plan.

import type { Cents, IsoDate } from '@vibe/types';

export type RecurringFrequency =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUAL'
  | 'ANNUAL';

/**
 * Add `n` months in UTC, clamping the day to the target month's length so
 * a day-29/30/31 anchor does NOT overflow into the following month. E.g.
 * Jan 31 + 1 month → Feb 28/29 (not Mar 3), which would otherwise skip a
 * period and permanently drift the recurrence anchor later.
 */
function addUtcMonthsClamped(d: Date, n: number): void {
  const day = d.getUTCDate();
  d.setUTCDate(1); // avoid the overflow while the month is changed
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDayOfMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfMonth));
}

/** Roll a date forward by the given frequency. */
export function nextRunDate(current: IsoDate, frequency: RecurringFrequency): IsoDate {
  const d = new Date(`${current}T00:00:00Z`);
  switch (frequency) {
    case 'WEEKLY':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'BIWEEKLY':
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case 'MONTHLY':
      addUtcMonthsClamped(d, 1);
      break;
    case 'QUARTERLY':
      addUtcMonthsClamped(d, 3);
      break;
    case 'SEMIANNUAL':
      addUtcMonthsClamped(d, 6);
      break;
    case 'ANNUAL':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Mid-cycle proration. Returns the prorated fee for a partial period.
 *
 * - `daysIn` = days actually in the cycle (e.g. days since plan started)
 * - `daysTotal` = total days in the cycle
 *
 * Caller is responsible for computing days for the relevant frequency.
 */
export function prorate(args: {
  fullAmountCents: Cents;
  daysIn: number;
  daysTotal: number;
}): Cents {
  if (args.daysTotal <= 0) return 0;
  const fraction = Math.max(0, Math.min(1, args.daysIn / args.daysTotal));
  return Math.round(args.fullAmountCents * fraction);
}

/**
 * Annual prepay discount. Returns the post-discount amount in cents.
 */
export function applyAnnualPrepayDiscount(amountCents: Cents, discountPct: number): Cents {
  const pct = Math.max(0, Math.min(100, discountPct));
  return Math.round(amountCents * (1 - pct / 100));
}

/**
 * Hour-bank balance from a stream of ledger entries.
 * Returns balance in hours (numeric, rounded to 2 decimals).
 */
export interface HourBankTxn {
  hoursDelta: number;
  type: 'PURCHASE' | 'DEBIT' | 'EXPIRE' | 'FORFEIT' | 'REFUND';
}

export function hourBankBalance(txns: HourBankTxn[]): number {
  const sum = txns.reduce((s, t) => s + t.hoursDelta, 0);
  return Math.round(sum * 100) / 100;
}

/**
 * Failed payment retry schedule. Returns the next retry timestamp given
 * the attempt count (1 = first failure → retry on day 3).
 * Q10 covers this — defaults 3/7/14 day spacing.
 */
export function nextRetryDate(
  attempt: number,
  baseDate: IsoDate,
  schedule: number[] = [3, 7, 14],
): IsoDate | null {
  if (attempt <= 0 || attempt > schedule.length) return null;
  const d = new Date(`${baseDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + schedule[attempt - 1]!);
  return d.toISOString().slice(0, 10);
}
