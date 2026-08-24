// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { attributePeriodTotals, computeWeeklyOvertime, standardHoursForPeriod } from './overtime';

describe('computeWeeklyOvertime', () => {
  it('flags hours over 40 per workweek', () => {
    // Monday-start week 2026-08-17..23: 45 worked.
    const weeks = computeWeeklyOvertime(
      {
        '2026-08-17': 9,
        '2026-08-18': 9,
        '2026-08-19': 9,
        '2026-08-20': 9,
        '2026-08-21': 9,
      },
      1,
    );
    expect(weeks).toEqual([
      { start: '2026-08-17', end: '2026-08-23', workedHours: 45, otHours: 5 },
    ]);
  });

  it('splits hours across week boundaries by the configured start day', () => {
    // Sunday-start weeks: Saturday 2026-08-22 belongs to the week starting
    // 2026-08-16; Sunday 2026-08-23 starts a new week.
    const weeks = computeWeeklyOvertime({ '2026-08-22': 8, '2026-08-23': 8 }, 0);
    expect(weeks.map((w) => w.start)).toEqual(['2026-08-16', '2026-08-23']);
    expect(weeks.every((w) => w.otHours === 0)).toBe(true);
  });
});

describe('standardHoursForPeriod', () => {
  it('prorates by frequency', () => {
    expect(standardHoursForPeriod(40, 'WEEKLY')).toBe(40);
    expect(standardHoursForPeriod(40, 'BIWEEKLY')).toBe(80);
    expect(standardHoursForPeriod(40, 'SEMI_MONTHLY')).toBe(86.67);
    expect(standardHoursForPeriod(40, 'MONTHLY')).toBe(173.33);
  });
});

describe('attributePeriodTotals', () => {
  it('non-exempt: regular = in-period worked minus attributed OT', () => {
    // Biweekly period 2026-08-17..30, Monday workweeks (both end inside).
    // Week 1: 45h → 5 OT. Week 2: 40h → 0 OT.
    const daily: Record<string, number> = {};
    for (const d of ['17', '18', '19', '20', '21']) daily[`2026-08-${d}`] = 9;
    for (const d of ['24', '25', '26', '27', '28']) daily[`2026-08-${d}`] = 8;
    const totals = attributePeriodTotals({
      period: { start: '2026-08-17', end: '2026-08-30' },
      dailyWorkedHours: daily,
      workweekStartDay: 1,
      overtimeExempt: false,
      standardHoursPerWeek: 40,
      frequency: 'BIWEEKLY',
    });
    expect(totals).toEqual({ actualWorkedHours: 85, regularHours: 80, otHours: 5 });
  });

  it('semi-monthly straddle: OT lands in the period where the workweek ends, no double count', () => {
    // Monday workweek Feb 9–15 ends in period A (Feb 1–15): 50h → 10 OT in A.
    // Workweek Feb 16–22 ends in period B (Feb 16–28): worked Feb 16–20
    // 44h → 4 OT in B.
    const daily: Record<string, number> = {
      '2026-02-09': 10,
      '2026-02-10': 10,
      '2026-02-11': 10,
      '2026-02-12': 10,
      '2026-02-13': 10,
      '2026-02-16': 9,
      '2026-02-17': 9,
      '2026-02-18': 9,
      '2026-02-19': 9,
      '2026-02-20': 8,
    };
    const a = attributePeriodTotals({
      period: { start: '2026-02-01', end: '2026-02-15' },
      dailyWorkedHours: daily,
      workweekStartDay: 1,
      overtimeExempt: false,
      standardHoursPerWeek: 40,
      frequency: 'SEMI_MONTHLY',
    });
    const b = attributePeriodTotals({
      period: { start: '2026-02-16', end: '2026-02-28' },
      dailyWorkedHours: daily,
      workweekStartDay: 1,
      overtimeExempt: false,
      standardHoursPerWeek: 40,
      frequency: 'SEMI_MONTHLY',
    });
    expect(a.otHours).toBe(10);
    expect(b.otHours).toBe(4);
    // No double count: regular+OT across both periods equals total worked.
    expect(a.regularHours + a.otHours + b.regularHours + b.otHours).toBe(94);
  });

  it('OT hours land in the period where they were worked, even when the week ends later', () => {
    // Week Mon Feb 23 – Sun Mar 1 ends in the March period, but all 48
    // hours were worked Feb 23–26: the 8 OT hours (cumulative crosses 40
    // during Feb 26) belong to the February period.
    const daily: Record<string, number> = {
      '2026-02-23': 12,
      '2026-02-24': 12,
      '2026-02-25': 12,
      '2026-02-26': 12,
    };
    const feb2 = attributePeriodTotals({
      period: { start: '2026-02-16', end: '2026-02-28' },
      dailyWorkedHours: daily,
      workweekStartDay: 1,
      overtimeExempt: false,
      standardHoursPerWeek: 40,
      frequency: 'SEMI_MONTHLY',
    });
    expect(feb2.otHours).toBe(8);
    expect(feb2.regularHours).toBe(40);
    expect(feb2.actualWorkedHours).toBe(48);
    // And the March period gets nothing from this week.
    const mar1 = attributePeriodTotals({
      period: { start: '2026-03-01', end: '2026-03-15' },
      dailyWorkedHours: daily,
      workweekStartDay: 1,
      overtimeExempt: false,
      standardHoursPerWeek: 40,
      frequency: 'SEMI_MONTHLY',
    });
    expect(mar1.otHours).toBe(0);
    expect(mar1.regularHours).toBe(0);
  });

  it('regression: no double pay when a week straddles and all hours sit in the earlier period', () => {
    // 50h worked Feb 24–28 (week ends Mar 1, zero March hours). The old
    // week-end attribution paid 50 regular in Feb AND 10 OT in Mar (60h
    // paid for 50 worked). Now: Feb = 40 regular + 10 OT, Mar = 0.
    const daily: Record<string, number> = {
      '2026-02-24': 10,
      '2026-02-25': 10,
      '2026-02-26': 10,
      '2026-02-27': 10,
      '2026-02-28': 10,
    };
    const feb = attributePeriodTotals({
      period: { start: '2026-02-16', end: '2026-02-28' },
      dailyWorkedHours: daily,
      workweekStartDay: 1,
      overtimeExempt: false,
      standardHoursPerWeek: 40,
      frequency: 'SEMI_MONTHLY',
    });
    const mar = attributePeriodTotals({
      period: { start: '2026-03-01', end: '2026-03-15' },
      dailyWorkedHours: daily,
      workweekStartDay: 1,
      overtimeExempt: false,
      standardHoursPerWeek: 40,
      frequency: 'SEMI_MONTHLY',
    });
    expect(feb).toEqual({ actualWorkedHours: 50, regularHours: 40, otHours: 10 });
    expect(mar).toEqual({ actualWorkedHours: 0, regularHours: 0, otHours: 0 });
    // Paid hours across periods equal hours worked.
    expect(feb.regularHours + feb.otHours + mar.regularHours + mar.otHours).toBe(50);
  });

  it('OT spanning the boundary splits by where the OT hours were worked', () => {
    // Week Mon Feb 23 – Sun Mar 1: 9h/day Feb 23–27 (45 cum by Fri), 9h
    // Sat Feb 28 (54), 9h Sun Mar 1 (63). Threshold crossed during Feb 27
    // → OT: 5h Feb 27 + 9h Feb 28 (period A) + 9h Mar 1 (period B).
    const daily: Record<string, number> = {
      '2026-02-23': 9,
      '2026-02-24': 9,
      '2026-02-25': 9,
      '2026-02-26': 9,
      '2026-02-27': 9,
      '2026-02-28': 9,
      '2026-03-01': 9,
    };
    const a = attributePeriodTotals({
      period: { start: '2026-02-16', end: '2026-02-28' },
      dailyWorkedHours: daily,
      workweekStartDay: 1,
      overtimeExempt: false,
      standardHoursPerWeek: 40,
      frequency: 'SEMI_MONTHLY',
    });
    const b = attributePeriodTotals({
      period: { start: '2026-03-01', end: '2026-03-15' },
      dailyWorkedHours: daily,
      workweekStartDay: 1,
      overtimeExempt: false,
      standardHoursPerWeek: 40,
      frequency: 'SEMI_MONTHLY',
    });
    expect(a).toEqual({ actualWorkedHours: 54, regularHours: 40, otHours: 14 });
    expect(b).toEqual({ actualWorkedHours: 9, regularHours: 0, otHours: 9 });
    expect(a.regularHours + a.otHours + b.regularHours + b.otHours).toBe(63);
  });

  it('exempt: standard hours as regular, actual carried separately, no OT', () => {
    const totals = attributePeriodTotals({
      period: { start: '2026-08-17', end: '2026-08-30' },
      dailyWorkedHours: { '2026-08-17': 12, '2026-08-18': 12, '2026-08-19': 12 },
      workweekStartDay: 1,
      overtimeExempt: true,
      standardHoursPerWeek: 40,
      frequency: 'BIWEEKLY',
    });
    expect(totals).toEqual({ actualWorkedHours: 36, regularHours: 80, otHours: 0 });
  });
});
