// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Balance = ledger credits − derived usage (time entries whose work code
// carries the bank's payroll category, status <> ARCHIVED). Overdraw is
// allowed by policy — the check only ever produces a warning.

import { round2 } from './dates';

export type TimeOffBank = 'PTO' | 'SICK' | 'COMP';

export const BANK_LABELS: Record<TimeOffBank, string> = {
  PTO: 'PTO / Vacation',
  SICK: 'Sick',
  COMP: 'Comp time',
};

export function computeBalance(ledgerTotal: number, usedHours: number): number {
  return round2(ledgerTotal - usedHours);
}

export interface OverdrawCheck {
  allowed: true;
  warning?: string;
}

/** Never blocks; warns when the projected balance would go negative. */
export function checkOverdraw(bank: TimeOffBank, projectedBalance: number): OverdrawCheck {
  if (projectedBalance >= 0) return { allowed: true };
  return {
    allowed: true,
    warning: `${BANK_LABELS[bank]} balance will go negative (${projectedBalance.toFixed(2)} hours)`,
  };
}
