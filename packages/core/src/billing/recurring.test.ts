// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, it, expect } from 'vitest';

import {
  applyAnnualPrepayDiscount,
  hourBankBalance,
  nextRetryDate,
  nextRunDate,
  prorate,
} from './recurring';

describe('nextRunDate', () => {
  it('rolls weekly', () => {
    expect(nextRunDate('2026-05-20', 'WEEKLY')).toBe('2026-05-27');
  });
  it('rolls biweekly', () => {
    expect(nextRunDate('2026-05-20', 'BIWEEKLY')).toBe('2026-06-03');
  });
  it('rolls monthly', () => {
    // Month-end anchors clamp to the target month's last day instead of
    // overflowing (which would skip a period and drift the anchor).
    expect(nextRunDate('2026-01-31', 'MONTHLY')).toBe('2026-02-28'); // clamp, not Mar 3
    expect(nextRunDate('2026-05-15', 'MONTHLY')).toBe('2026-06-15');
    expect(nextRunDate('2026-01-30', 'MONTHLY')).toBe('2026-02-28');
    // A clamped anchor does not "stick" short — the 31st recurs where it can.
    expect(nextRunDate('2026-03-31', 'MONTHLY')).toBe('2026-04-30');
  });
  it('clamps month-end for leap February', () => {
    expect(nextRunDate('2028-01-31', 'MONTHLY')).toBe('2028-02-29'); // 2028 is leap
  });
  it('rolls quarterly / semi-annual / annual', () => {
    expect(nextRunDate('2026-01-15', 'QUARTERLY')).toBe('2026-04-15');
    expect(nextRunDate('2026-01-15', 'SEMIANNUAL')).toBe('2026-07-15');
    expect(nextRunDate('2026-01-15', 'ANNUAL')).toBe('2027-01-15');
    expect(nextRunDate('2026-11-30', 'QUARTERLY')).toBe('2027-02-28'); // month-end clamp
  });
});

describe('prorate', () => {
  it('returns 0 for zero-day cycles', () => {
    expect(prorate({ fullAmountCents: 100000, daysIn: 5, daysTotal: 0 })).toBe(0);
  });
  it('returns the full amount when daysIn >= daysTotal', () => {
    expect(prorate({ fullAmountCents: 100000, daysIn: 30, daysTotal: 30 })).toBe(100000);
    expect(prorate({ fullAmountCents: 100000, daysIn: 60, daysTotal: 30 })).toBe(100000);
  });
  it('halves at the midpoint', () => {
    expect(prorate({ fullAmountCents: 100000, daysIn: 15, daysTotal: 30 })).toBe(50000);
  });
});

describe('applyAnnualPrepayDiscount', () => {
  it('zero discount returns the input', () => {
    expect(applyAnnualPrepayDiscount(100000, 0)).toBe(100000);
  });
  it('10% off', () => {
    expect(applyAnnualPrepayDiscount(100000, 10)).toBe(90000);
  });
  it('clamps to [0, 100]', () => {
    expect(applyAnnualPrepayDiscount(100000, -5)).toBe(100000);
    expect(applyAnnualPrepayDiscount(100000, 150)).toBe(0);
  });
});

describe('hourBankBalance', () => {
  it('sums deltas with 2-decimal rounding', () => {
    expect(
      hourBankBalance([
        { type: 'PURCHASE', hoursDelta: 40 },
        { type: 'DEBIT', hoursDelta: -2.5 },
        { type: 'DEBIT', hoursDelta: -1.25 },
      ]),
    ).toBe(36.25);
  });
});

describe('nextRetryDate', () => {
  it('uses the default 3/7/14 schedule', () => {
    expect(nextRetryDate(1, '2026-05-01')).toBe('2026-05-04');
    expect(nextRetryDate(2, '2026-05-01')).toBe('2026-05-08');
    expect(nextRetryDate(3, '2026-05-01')).toBe('2026-05-15');
  });
  it('returns null past the schedule', () => {
    expect(nextRetryDate(4, '2026-05-01')).toBeNull();
  });
});
