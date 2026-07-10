// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Deterministic bottom-up pricing engine. The ENGINE picks the number (a range)
// from structured inputs; the LLM only writes prose. Same inputs → same number.
//
// Hard invariants (also covered by tests):
//   - Target margin is a TRUE GROSS MARGIN applied by DIVISION: cost / (1 − m).
//     Never cost × (1 + m) — that is a markup (40% markup ≈ 28.6% margin).
//   - The cost base is built from BURDENED COST rates per tier, never billable
//     rates (billable already contains profit → would double-count margin).
//   - The economic factor is applied EXACTLY ONCE, AFTER the margin gross-up.
//   - Confidence band widens as the cohort/data thins; below the cohort minimum
//     the engine falls back to prior-fee × economic uplift, flagged low-confidence.

export type RateTier = 'PARTNER' | 'MANAGER' | 'REVIEWER' | 'PREPARER' | 'STAFF';

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface TierInput {
  tier: RateTier;
  /** Normalized expected hours for this tier (NOT this engagement's raw actuals). */
  expectedHours: number;
  /** Fully-burdened COST rate per hour, in cents (salary+benefits+overhead). */
  burdenedCostRateCents: number;
}

export interface PriceInputs {
  tiers: TierInput[];
  /** True gross margin as a percent, 0..<100 (default policy 40). */
  targetMarginPct: number;
  /** Economic factor as a percent (e.g. 3.2), applied ONCE after the gross-up. */
  economicFactorPct: number;
  /** Number of engagements in the cohort — drives confidence + the fallback. */
  cohortSize: number;
  /** Minimum cohort size to trust the cost build (else prior-fee fallback). */
  cohortMin: number;
  /** Prior fee in cents — only used by the thin-cohort fallback. */
  priorFeeCents?: number | null;
}

export interface TierBreakdown extends TierInput {
  costCents: number; // round(expectedHours × burdenedCostRateCents)
}

export interface PriceResult {
  mode: 'COST_BUILD' | 'PRIOR_FEE_FALLBACK';
  costBaseCents: number;
  breakdownByTier: TierBreakdown[];
  targetMarginPct: number;
  economicFactorPct: number;
  grossedUpCents: number; // cost / (1 − margin)
  suggestedCents: number; // grossedUp × (1 + economic)
  lowCents: number;
  highCents: number;
  confidence: Confidence;
  /** Half-band width as a fraction of the suggested figure (e.g. 0.08 = ±8%). */
  bandPct: number;
}

// Confidence → half-band width. Thinner data → wider band (Q8).
const BAND: Record<Confidence, number> = { HIGH: 0.08, MEDIUM: 0.15, LOW: 0.25 };

function confidenceFor(cohortSize: number, cohortMin: number): Confidence {
  if (cohortSize >= Math.max(cohortMin * 2, 12)) return 'HIGH';
  if (cohortSize >= cohortMin) return 'MEDIUM';
  return 'LOW';
}

/** Gross up a cost to a price at a true gross margin, by DIVISION. */
export function grossUpByMargin(costCents: number, targetMarginPct: number): number {
  if (!(targetMarginPct >= 0 && targetMarginPct < 100)) {
    throw new Error(`target margin out of range: ${targetMarginPct}`);
  }
  const margin = targetMarginPct / 100;
  return Math.round(costCents / (1 - margin));
}

/** Apply the economic factor exactly once. */
function applyEconomic(cents: number, economicFactorPct: number): number {
  return Math.round(cents * (1 + economicFactorPct / 100));
}

function band(
  suggested: number,
  confidence: Confidence,
): { low: number; high: number; pct: number } {
  const pct = BAND[confidence];
  const half = Math.round(suggested * pct);
  return { low: Math.max(0, suggested - half), high: suggested + half, pct };
}

export function buildPrice(inputs: PriceInputs): PriceResult {
  // Thin-cohort fallback: prior fee × economic uplift, widest band.
  if (inputs.cohortSize < inputs.cohortMin) {
    const base = Math.max(0, inputs.priorFeeCents ?? 0);
    const suggested = applyEconomic(base, inputs.economicFactorPct);
    const b = band(suggested, 'LOW');
    return {
      mode: 'PRIOR_FEE_FALLBACK',
      costBaseCents: 0,
      breakdownByTier: [],
      targetMarginPct: inputs.targetMarginPct,
      economicFactorPct: inputs.economicFactorPct,
      grossedUpCents: base,
      suggestedCents: suggested,
      lowCents: b.low,
      highCents: b.high,
      confidence: 'LOW',
      bandPct: b.pct,
    };
  }

  // Cost build. Step 1: burdened cost base.
  const breakdownByTier: TierBreakdown[] = inputs.tiers.map((t) => ({
    ...t,
    costCents: Math.round(t.expectedHours * t.burdenedCostRateCents),
  }));
  const costBaseCents = breakdownByTier.reduce((s, b) => s + b.costCents, 0);

  // Step 2: gross up by TRUE GROSS MARGIN via DIVISION (exactly once).
  const grossedUpCents = grossUpByMargin(costBaseCents, inputs.targetMarginPct);

  // Step 3: apply the economic factor ONCE, AFTER the gross-up.
  const suggestedCents = applyEconomic(grossedUpCents, inputs.economicFactorPct);

  const confidence = confidenceFor(inputs.cohortSize, inputs.cohortMin);
  const b = band(suggestedCents, confidence);
  return {
    mode: 'COST_BUILD',
    costBaseCents,
    breakdownByTier,
    targetMarginPct: inputs.targetMarginPct,
    economicFactorPct: inputs.economicFactorPct,
    grossedUpCents,
    suggestedCents,
    lowCents: b.low,
    highCents: b.high,
    confidence,
    bandPct: b.pct,
  };
}
