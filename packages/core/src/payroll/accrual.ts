// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Accrual math for PTO/Sick/Comp policies. All functions are pure; the
// worker supplies context (tenure, balances, worked hours) and writes
// idempotent ledger rows from the results.

import type { IsoDate } from '@vibe/types';

import { addDays, diffDays, round2, yearOf } from './dates';

export type AccrualMethod = 'FIXED_PER_PERIOD' | 'PER_HOURS_WORKED' | 'ANNUAL_GRANT';

export interface AccrualPolicyInput {
  method: AccrualMethod;
  hoursPerPeriod: number | null;
  earnHours: number | null;
  perWorkedHours: number | null;
  annualGrantHours: number | null;
  annualGrantTiming: 'CALENDAR_YEAR' | 'ANNIVERSARY' | null;
  accrualWaitingDays: number;
  usageWaitingDays: number;
  maxBalanceHours: number | null;
  carryoverCapHours: number | null;
}

export interface PolicyTier {
  minYearsService: number;
  rateHours: number;
}

export function tenureYearsAt(hiredDate: IsoDate | null, asOf: IsoDate): number {
  if (!hiredDate) return 0;
  return Math.max(0, diffDays(hiredDate, asOf) / 365.25);
}

/** Highest tier at or below tenure wins; no tier → the base rate. */
export function resolveTierRate(
  baseRate: number,
  tiers: PolicyTier[],
  tenureYears: number,
): number {
  let rate = baseRate;
  let best = -1;
  for (const t of tiers) {
    if (t.minYearsService <= tenureYears && t.minYearsService > best) {
      best = t.minYearsService;
      rate = t.rateHours;
    }
  }
  return rate;
}

export interface AccrualContext {
  hiredDate: IsoDate | null;
  leftDate: IsoDate | null;
  periodEnd: IsoDate;
  hoursWorkedInPeriod: number;
  currentBalance: number;
  tiers: PolicyTier[];
}

/** Clamp so balance never exceeds the policy ceiling. */
function clampToMax(accrued: number, policy: AccrualPolicyInput, currentBalance: number): number {
  if (accrued <= 0) return 0;
  if (policy.maxBalanceHours == null) return round2(accrued);
  return round2(Math.min(accrued, Math.max(0, policy.maxBalanceHours - currentBalance)));
}

/**
 * Hours accrued for one completed pay period (FIXED_PER_PERIOD and
 * PER_HOURS_WORKED methods; ANNUAL_GRANT accrues via computeAnnualGrant).
 */
export function computePeriodAccrual(policy: AccrualPolicyInput, ctx: AccrualContext): number {
  if (ctx.leftDate && ctx.leftDate < ctx.periodEnd) return 0;
  if (ctx.hiredDate && addDays(ctx.hiredDate, policy.accrualWaitingDays) > ctx.periodEnd) {
    return 0;
  }
  const tenure = tenureYearsAt(ctx.hiredDate, ctx.periodEnd);
  switch (policy.method) {
    case 'FIXED_PER_PERIOD': {
      const rate = resolveTierRate(policy.hoursPerPeriod ?? 0, ctx.tiers, tenure);
      return clampToMax(rate, policy, ctx.currentBalance);
    }
    case 'PER_HOURS_WORKED': {
      const earn = resolveTierRate(policy.earnHours ?? 0, ctx.tiers, tenure);
      const per = policy.perWorkedHours ?? 0;
      if (per <= 0) return 0;
      return clampToMax((earn / per) * ctx.hoursWorkedInPeriod, policy, ctx.currentBalance);
    }
    case 'ANNUAL_GRANT':
      return 0;
  }
}

export interface AnnualGrantContext {
  hiredDate: IsoDate | null;
  leftDate: IsoDate | null;
  today: IsoDate;
  currentBalance: number;
  tiers: PolicyTier[];
}

export interface AnnualGrantResult {
  grantHours: number;
  /** 'ANNUAL:<year>' or 'ANNIV:<year>' — the ledger idempotency key. */
  periodKey: string;
}

/**
 * The grant due in `today`'s calendar year, or null when none is due yet
 * (before Jan 1 has no meaning; before the anniversary date; within the
 * waiting period; after departure). Clamped to the balance ceiling.
 */
export function computeAnnualGrant(
  policy: AccrualPolicyInput,
  ctx: AnnualGrantContext,
): AnnualGrantResult | null {
  if (policy.method !== 'ANNUAL_GRANT') return null;
  if (ctx.leftDate && ctx.leftDate < ctx.today) return null;
  const year = yearOf(ctx.today);
  let dueDate: IsoDate;
  let periodKey: string;
  if (policy.annualGrantTiming === 'ANNIVERSARY') {
    if (!ctx.hiredDate) return null;
    dueDate = `${year}${ctx.hiredDate.slice(4)}`;
    periodKey = `ANNIV:${year}`;
  } else {
    dueDate = `${year}-01-01`;
    periodKey = `ANNUAL:${year}`;
  }
  if (ctx.today < dueDate) return null;
  if (ctx.hiredDate && addDays(ctx.hiredDate, policy.accrualWaitingDays) > dueDate) return null;
  const tenure = tenureYearsAt(ctx.hiredDate, dueDate);
  const rate = resolveTierRate(policy.annualGrantHours ?? 0, ctx.tiers, tenure);
  const grantHours = clampToMax(rate, policy, ctx.currentBalance);
  if (grantHours <= 0) return null;
  return { grantHours, periodKey };
}

/**
 * Signed forfeit delta for the Jan-1 carryover job: 0 when under the cap,
 * negative (the excess) when over. carryoverCapHours null = no forfeit.
 */
export function computeCarryoverForfeit(
  balanceAtYearEnd: number,
  carryoverCapHours: number | null,
): number {
  if (carryoverCapHours == null) return 0;
  return round2(Math.min(0, carryoverCapHours - balanceAtYearEnd));
}

/** Whether usage is allowed on `onDate` given the policy waiting period. */
export function usageAllowed(
  policy: Pick<AccrualPolicyInput, 'usageWaitingDays'>,
  hiredDate: IsoDate | null,
  onDate: IsoDate,
): boolean {
  if (!hiredDate) return true;
  return addDays(hiredDate, policy.usageWaitingDays) <= onDate;
}
