// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import {
  type AccrualPolicyInput,
  computeAnnualGrant,
  computeCarryoverForfeit,
  computePeriodAccrual,
  resolveTierRate,
  tenureYearsAt,
  usageAllowed,
} from './accrual';
import { checkOverdraw, computeBalance } from './balances';

const base: AccrualPolicyInput = {
  method: 'FIXED_PER_PERIOD',
  hoursPerPeriod: 4,
  earnHours: null,
  perWorkedHours: null,
  annualGrantHours: null,
  annualGrantTiming: null,
  accrualWaitingDays: 0,
  usageWaitingDays: 0,
  maxBalanceHours: null,
  carryoverCapHours: null,
};

const ctx = {
  hiredDate: '2020-06-01',
  leftDate: null,
  periodEnd: '2026-08-15',
  hoursWorkedInPeriod: 80,
  currentBalance: 20,
  tiers: [],
};

describe('computePeriodAccrual', () => {
  it('fixed per period accrues the flat rate', () => {
    expect(computePeriodAccrual(base, ctx)).toBe(4);
  });

  it('per hours worked earns proportionally (1 per 30)', () => {
    const policy: AccrualPolicyInput = {
      ...base,
      method: 'PER_HOURS_WORKED',
      hoursPerPeriod: null,
      earnHours: 1,
      perWorkedHours: 30,
    };
    expect(computePeriodAccrual(policy, { ...ctx, hoursWorkedInPeriod: 90 })).toBe(3);
    expect(computePeriodAccrual(policy, { ...ctx, hoursWorkedInPeriod: 0 })).toBe(0);
  });

  it('tenure tiers override the base rate at the highest met threshold', () => {
    const tiers = [
      { minYearsService: 2, rateHours: 5 },
      { minYearsService: 5, rateHours: 6 },
    ];
    // Hired 2020-06-01, period end 2026-08-15 → ~6.2 years → the 5-year tier.
    expect(computePeriodAccrual(base, { ...ctx, tiers })).toBe(6);
    // A newer hire (~1 year) stays on the base rate.
    expect(computePeriodAccrual(base, { ...ctx, tiers, hiredDate: '2025-06-01' })).toBe(4);
  });

  it('waiting period suppresses accrual until served', () => {
    const policy = { ...base, accrualWaitingDays: 90 };
    expect(computePeriodAccrual(policy, { ...ctx, hiredDate: '2026-08-01' })).toBe(0);
    expect(computePeriodAccrual(policy, { ...ctx, hiredDate: '2026-01-01' })).toBe(4);
  });

  it('max balance cap clamps accrual and stops at the ceiling', () => {
    const policy = { ...base, maxBalanceHours: 22 };
    expect(computePeriodAccrual(policy, ctx)).toBe(2);
    expect(computePeriodAccrual(policy, { ...ctx, currentBalance: 25 })).toBe(0);
  });

  it('no accrual after departure', () => {
    expect(computePeriodAccrual(base, { ...ctx, leftDate: '2026-07-31' })).toBe(0);
  });

  it('annual-grant policies accrue nothing per period', () => {
    expect(computePeriodAccrual({ ...base, method: 'ANNUAL_GRANT' }, ctx)).toBe(0);
  });
});

describe('computeAnnualGrant', () => {
  const grant: AccrualPolicyInput = {
    ...base,
    method: 'ANNUAL_GRANT',
    hoursPerPeriod: null,
    annualGrantHours: 80,
    annualGrantTiming: 'CALENDAR_YEAR',
  };

  it('calendar-year grant is due from Jan 1 with an ANNUAL key', () => {
    const r = computeAnnualGrant(grant, {
      hiredDate: '2020-06-01',
      leftDate: null,
      today: '2026-01-02',
      currentBalance: 0,
      tiers: [],
    });
    expect(r).toEqual({ grantHours: 80, periodKey: 'ANNUAL:2026' });
  });

  it('anniversary grant waits for the hire anniversary', () => {
    const policy: AccrualPolicyInput = { ...grant, annualGrantTiming: 'ANNIVERSARY' };
    const before = computeAnnualGrant(policy, {
      hiredDate: '2020-06-01',
      leftDate: null,
      today: '2026-05-31',
      currentBalance: 0,
      tiers: [],
    });
    expect(before).toBeNull();
    const after = computeAnnualGrant(policy, {
      hiredDate: '2020-06-01',
      leftDate: null,
      today: '2026-06-01',
      currentBalance: 0,
      tiers: [],
    });
    expect(after).toEqual({ grantHours: 80, periodKey: 'ANNIV:2026' });
  });

  it('clamps to the balance ceiling', () => {
    const r = computeAnnualGrant(
      { ...grant, maxBalanceHours: 100 },
      { hiredDate: null, leftDate: null, today: '2026-02-01', currentBalance: 60, tiers: [] },
    );
    expect(r?.grantHours).toBe(40);
  });

  it('tenure tier can raise the grant', () => {
    const r = computeAnnualGrant(grant, {
      hiredDate: '2020-06-01',
      leftDate: null,
      today: '2026-01-02',
      currentBalance: 0,
      tiers: [{ minYearsService: 5, rateHours: 120 }],
    });
    expect(r?.grantHours).toBe(120);
  });
});

describe('computeAnnualGrant — waiting period', () => {
  const policy: AccrualPolicyInput = {
    ...base,
    method: 'ANNUAL_GRANT',
    annualGrantTiming: 'CALENDAR_YEAR',
    annualGrantHours: 80,
    accrualWaitingDays: 90,
  };

  it('grants once the wait is served, not the following year', () => {
    const hire = { hiredDate: '2025-11-15', leftDate: null, currentBalance: 0, tiers: [] };
    // The wait ends 2026-02-13. Measuring it against the Jan-1 grant date
    // skipped the whole of 2026 and only paid out on 2027-01-01.
    expect(computeAnnualGrant(policy, { ...hire, today: '2026-01-05' })).toBeNull();
    expect(computeAnnualGrant(policy, { ...hire, today: '2026-02-12' })).toBeNull();
    const granted = computeAnnualGrant(policy, { ...hire, today: '2026-02-13' });
    expect(granted?.grantHours).toBe(80);
    expect(granted?.periodKey).toBe('ANNUAL:2026');
  });

  it('is unchanged for a hire whose wait was already served', () => {
    const hire = { hiredDate: '2024-03-01', leftDate: null, currentBalance: 0, tiers: [] };
    expect(computeAnnualGrant(policy, { ...hire, today: '2026-01-01' })?.grantHours).toBe(80);
  });
});

describe('carryover, tenure, usage, balances', () => {
  it('forfeits only the excess over the carryover cap', () => {
    expect(computeCarryoverForfeit(55, 40)).toBe(-15);
    expect(computeCarryoverForfeit(30, 40)).toBe(0);
    expect(computeCarryoverForfeit(55, null)).toBe(0);
  });

  it('tenureYearsAt is fractional years since hire', () => {
    expect(tenureYearsAt('2024-08-15', '2026-08-15')).toBeCloseTo(2, 1);
    expect(tenureYearsAt(null, '2026-08-15')).toBe(0);
  });

  it('resolveTierRate falls back to base with no tiers met', () => {
    expect(resolveTierRate(4, [{ minYearsService: 10, rateHours: 8 }], 3)).toBe(4);
  });

  it('usageAllowed honors the usage waiting period', () => {
    expect(usageAllowed({ usageWaitingDays: 90 }, '2026-06-01', '2026-08-01')).toBe(false);
    expect(usageAllowed({ usageWaitingDays: 90 }, '2026-06-01', '2026-09-01')).toBe(true);
    expect(usageAllowed({ usageWaitingDays: 90 }, null, '2026-08-01')).toBe(true);
  });

  it('overdraw warns but never blocks', () => {
    expect(checkOverdraw('PTO', 5)).toEqual({ allowed: true });
    const over = checkOverdraw('SICK', -3.5);
    expect(over.allowed).toBe(true);
    expect(over.warning).toContain('negative');
  });

  it('computeBalance is credits minus derived usage', () => {
    expect(computeBalance(44, 12.5)).toBe(31.5);
  });
});
