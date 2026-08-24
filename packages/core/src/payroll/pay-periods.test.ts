// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import {
  generatePayPeriods,
  payPeriodForDate,
  workweekStartFor,
  workweeksEndingInRange,
} from './pay-periods';

describe('payPeriodForDate', () => {
  it('weekly tiles from the anchor', () => {
    // Anchor Monday 2026-01-05.
    expect(payPeriodForDate('WEEKLY', '2026-01-05', '2026-01-05')).toEqual({
      start: '2026-01-05',
      end: '2026-01-11',
    });
    expect(payPeriodForDate('WEEKLY', '2026-01-05', '2026-01-11')).toEqual({
      start: '2026-01-05',
      end: '2026-01-11',
    });
    expect(payPeriodForDate('WEEKLY', '2026-01-05', '2026-01-12')).toEqual({
      start: '2026-01-12',
      end: '2026-01-18',
    });
    // Before the anchor still resolves (negative k).
    expect(payPeriodForDate('WEEKLY', '2026-01-05', '2026-01-04')).toEqual({
      start: '2025-12-29',
      end: '2026-01-04',
    });
  });

  it('biweekly tiles 14 days from the anchor', () => {
    expect(payPeriodForDate('BIWEEKLY', '2026-01-05', '2026-01-18')).toEqual({
      start: '2026-01-05',
      end: '2026-01-18',
    });
    expect(payPeriodForDate('BIWEEKLY', '2026-01-05', '2026-01-19')).toEqual({
      start: '2026-01-19',
      end: '2026-02-01',
    });
  });

  it('semi-monthly is 1–15 / 16–EOM', () => {
    expect(payPeriodForDate('SEMI_MONTHLY', null, '2026-02-15')).toEqual({
      start: '2026-02-01',
      end: '2026-02-15',
    });
    expect(payPeriodForDate('SEMI_MONTHLY', null, '2026-02-16')).toEqual({
      start: '2026-02-16',
      end: '2026-02-28',
    });
    // Leap year EOM.
    expect(payPeriodForDate('SEMI_MONTHLY', null, '2028-02-20').end).toBe('2028-02-29');
  });

  it('monthly is the calendar month', () => {
    expect(payPeriodForDate('MONTHLY', null, '2026-04-10')).toEqual({
      start: '2026-04-01',
      end: '2026-04-30',
    });
  });
});

describe('generatePayPeriods', () => {
  it('returns every period overlapping the window', () => {
    const periods = generatePayPeriods('BIWEEKLY', '2026-01-05', '2026-01-10', '2026-02-10');
    expect(periods).toEqual([
      { start: '2026-01-05', end: '2026-01-18' },
      { start: '2026-01-19', end: '2026-02-01' },
      { start: '2026-02-02', end: '2026-02-15' },
    ]);
  });

  it('semi-monthly spans month boundaries', () => {
    const periods = generatePayPeriods('SEMI_MONTHLY', null, '2026-01-20', '2026-02-20');
    expect(periods.map((p) => p.start)).toEqual(['2026-01-16', '2026-02-01', '2026-02-16']);
  });
});

describe('workweeks', () => {
  it('workweekStartFor backs up to the configured start day', () => {
    // 2026-08-19 is a Wednesday; workweek starts Monday (1).
    expect(workweekStartFor('2026-08-19', 1)).toBe('2026-08-17');
    // Sunday-start week containing a Wednesday.
    expect(workweekStartFor('2026-08-19', 0)).toBe('2026-08-16');
    // A date on the start day is its own week start.
    expect(workweekStartFor('2026-08-17', 1)).toBe('2026-08-17');
  });

  it('workweeksEndingInRange only includes weeks whose last day is inside', () => {
    // Semi-monthly period Feb 1–15 2026, Monday workweeks. Weeks ending
    // inside: Feb 1 (Jan 26–Feb 1), Feb 8, Feb 15. The week ending Feb 22
    // (started Feb 16) is excluded even though it starts outside.
    const weeks = workweeksEndingInRange('2026-02-01', '2026-02-15', 1);
    expect(weeks.map((w) => w.end)).toEqual(['2026-02-01', '2026-02-08', '2026-02-15']);
    expect(weeks[0]?.start).toBe('2026-01-26');
  });
});
