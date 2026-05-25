// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R1 — Retainer expiry computation (D3 + D23).
//
//   expiry_date = COALESCE(extended_due_date, original_due_date) + 3 years
//
// Frozen at activation per D23 (no retroactive UI for changing it).
// Both dates are ISO YYYY-MM-DD strings. The +3 year math is calendar-
// aware: Feb 29 → Feb 28 in non-leap years.

export interface ComputeExpiryInput {
  originalDueDate: string | null;
  extendedDueDate: string | null;
}

/**
 * Returns the expiry date as an ISO YYYY-MM-DD string. Throws if both
 * inputs are null — the activation handler must validate beforehand
 * that at least one is set.
 */
export function computeExpiryDate(input: ComputeExpiryInput): string {
  const base = input.extendedDueDate ?? input.originalDueDate;
  if (!base) {
    throw new Error('at least one of extendedDueDate / originalDueDate is required');
  }
  return addYears(base, 3);
}

/**
 * Add `years` to an ISO YYYY-MM-DD date string. Calendar-aware:
 * 2024-02-29 + 3 years → 2027-02-28 (clamps to last day of month).
 */
export function addYears(iso: string, years: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`invalid ISO date: ${iso}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const newY = y + years;
  // Days in newY/mo
  const last = lastDayOfMonth(newY, mo);
  const newD = Math.min(d, last);
  return `${String(newY).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(newD).padStart(2, '0')}`;
}

function lastDayOfMonth(year: number, month: number): number {
  // Month is 1-12. Use Date(0)-based math.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
