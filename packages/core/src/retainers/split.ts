// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R1 — Time-entry auto-split math (D1).
//
// Pure function — no DB. Race-safety lives in the SQL layer (R5 wraps
// the consumption write in a SELECT ... FOR UPDATE transaction). This
// math just decides "given current balance and an entry's hours, how
// many go to retainer vs. spillover".
//
// Hours are decimal (numeric(8,2) in the DB). JS-side we use number;
// the multiply-by-100 trick keeps the boundary check exact even with
// floating-point arithmetic.

export interface ComputeSplitInput {
  entryHours: number;
  hoursPurchased: number;
  hoursConsumed: number;
}

export interface ComputeSplitResult {
  /** Hours debited from the retainer (0 ≤ applied ≤ entryHours). */
  applied: number;
  /** Hours that overflow to billable WIP. */
  spillover: number;
  /** True iff applying this entry brings consumed to purchased. */
  willExhaust: boolean;
}

const SCALE = 100;

function toCents(hours: number): number {
  // numeric(8,2) → integer hundredths-of-hour. Round to avoid float drift.
  return Math.round(hours * SCALE);
}

function fromCents(cents: number): number {
  return cents / SCALE;
}

export function computeSplit(input: ComputeSplitInput): ComputeSplitResult {
  if (input.entryHours <= 0) {
    throw new Error('entryHours must be positive');
  }
  const entryC = toCents(input.entryHours);
  const purchasedC = toCents(input.hoursPurchased);
  const consumedC = toCents(input.hoursConsumed);
  const remainingC = Math.max(0, purchasedC - consumedC);
  const appliedC = Math.min(entryC, remainingC);
  const spilloverC = entryC - appliedC;
  return {
    applied: fromCents(appliedC),
    spillover: fromCents(spilloverC),
    willExhaust: appliedC > 0 && consumedC + appliedC === purchasedC,
  };
}
