// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R1 — Retainer tier price math (D10).
//
//   price_cents = base_fee_cents + (pct_of_prep_fee_bps × basis_cents) / 10000
//
// Stored pct is in basis points (0..10000 → 0%..100%), matching the
// codebase convention (engagement.rate_multiplier_bps). All inputs are
// integers; the multiply-then-divide order avoids float drift.
//
// Rounding policy: round half to even ("banker's rounding") on the
// final cents. This keeps long-running aggregates statistically
// unbiased and matches the rounding mode used by the invoicing engine.

export interface ComputeTierPriceInput {
  baseFeeCents: number;
  pctOfPrepFeeBps: number;
  basisCents: number;
}

export function computeTierPrice(input: ComputeTierPriceInput): number {
  if (!Number.isInteger(input.baseFeeCents) || input.baseFeeCents < 0) {
    throw new Error('baseFeeCents must be a non-negative integer');
  }
  if (
    !Number.isInteger(input.pctOfPrepFeeBps) ||
    input.pctOfPrepFeeBps < 0 ||
    input.pctOfPrepFeeBps > 10000
  ) {
    throw new Error('pctOfPrepFeeBps must be an integer in [0, 10000]');
  }
  if (!Number.isInteger(input.basisCents) || input.basisCents < 0) {
    throw new Error('basisCents must be a non-negative integer');
  }
  // Use bigint internally so the multiply doesn't overflow on large bases.
  const numerator = BigInt(input.pctOfPrepFeeBps) * BigInt(input.basisCents);
  const denom = 10000n;
  const variable = bankersDivide(numerator, denom);
  return input.baseFeeCents + Number(variable);
}

/**
 * Integer division with round-half-to-even. Both inputs are bigint.
 * Returns the bigint result.
 */
export function bankersDivide(num: bigint, denom: bigint): bigint {
  if (denom <= 0n) throw new Error('denom must be positive');
  const quotient = num / denom;
  const remainder = num % denom;
  const twice = remainder * 2n;
  if (twice < denom) return quotient;
  if (twice > denom) return quotient + 1n;
  // Exactly half — round to even.
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}
