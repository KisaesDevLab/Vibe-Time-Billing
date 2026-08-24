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

  it('a workweek straddling INTO the period does not attribute its OT here', () => {
    // Week Feb 16–22 ends in the second half; hours logged Feb 13 belong
    // to the week ending Feb 15 which ends in period A.
    const daily: Record<string, number> = {
      // Week Mon Feb 23 – Sun Mar 1 ends in March period.
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
    // 48 worked in-period, but the week ends Mar 1 → OT attributed to March.
    expect(feb2.otHours).toBe(0);
    expect(feb2.actualWorkedHours).toBe(48);
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
