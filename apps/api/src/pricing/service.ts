// SPDX-License-Identifier: Elastic-2.0
//
// Pricing-suggestion orchestration (PS Phase 8). Assembles cohort inputs →
// resolves the economic factor → runs the deterministic engine (with any
// edited drivers from the UI) → computes the Tier-2 signals → builds the
// rationale. Pure-ish: all DB access via the passed `db`; AI via the injected
// `aiComplete` (null = templated rationale).

import { buildPrice, type PriceResult, type RateTier } from '@vibe/core/pricing';

import { assemblePricingInputs } from './cohort';
import { resolveEconomicFactor, type EconomicFactor, type EconomicSource } from './economic';
import { buildRationale, type AiComplete } from './rationale';
import { computeSanitySignals, type SanitySignals } from './tier2';
import type { Database } from '@vibe/db';

export interface PricingSettingsRow {
  pricingEconomicSource: string;
  pricingEconomicManualPct: string;
  pricingTargetMarginPct: string;
  pricingExpectedHoursStat: 'TRIMMED_MEAN' | 'MEDIAN';
  pricingCohortMin: number;
  pricingBurdenedCostPerTier: Record<string, number>;
}

export interface SuggestionOverrides {
  tiers?: { tier: RateTier; expectedHours?: number; burdenedCostRateCents?: number }[];
  targetMarginPct?: number;
  economicFactorPct?: number;
}

export interface PricingSuggestion {
  price: PriceResult;
  economic: EconomicFactor;
  signals: SanitySignals;
  rationale: { text: string; source: 'AI' | 'TEMPLATE' };
  ownActualHoursByTier: Record<RateTier, number>;
  complexity: string;
  cohortSize: number;
  statistic: 'TRIMMED_MEAN' | 'MEDIAN';
  returnType: string | null;
}

export async function computePricingSuggestion(
  db: Database,
  opts: {
    firmId: string;
    engagementId: string;
    settings: PricingSettingsRow;
    overrides?: SuggestionOverrides;
    aiComplete?: AiComplete | null;
  },
): Promise<PricingSuggestion> {
  const assembly = await assemblePricingInputs(db, {
    firmId: opts.firmId,
    engagementId: opts.engagementId,
    settings: {
      pricingExpectedHoursStat: opts.settings.pricingExpectedHoursStat,
      pricingBurdenedCostPerTier: opts.settings.pricingBurdenedCostPerTier,
    },
  });

  const economic = await resolveEconomicFactor(db, {
    firmId: opts.firmId,
    source: (opts.settings.pricingEconomicSource as EconomicSource) ?? 'MANUAL',
    manualPct: Number(opts.settings.pricingEconomicManualPct),
  });

  // Overlay any edited drivers from the UI onto the assembled inputs.
  const ov = opts.overrides;
  const tiers = assembly.tiers.map((t) => {
    const o = ov?.tiers?.find((x) => x.tier === t.tier);
    return {
      tier: t.tier,
      expectedHours: o?.expectedHours ?? t.expectedHours,
      burdenedCostRateCents: o?.burdenedCostRateCents ?? t.burdenedCostRateCents,
    };
  });
  const targetMarginPct = ov?.targetMarginPct ?? Number(opts.settings.pricingTargetMarginPct);
  const economicFactorPct = ov?.economicFactorPct ?? economic.pct;

  const price = buildPrice({
    tiers,
    targetMarginPct,
    economicFactorPct,
    cohortSize: assembly.cohortSize,
    cohortMin: opts.settings.pricingCohortMin,
    priorFeeCents: assembly.priorFeeCents,
  });

  const signals = await computeSanitySignals(db, {
    subjectEngagementId: opts.engagementId,
    cohortEngagementIds: assembly.cohortEngagementIds,
  });

  const economicUsed: EconomicFactor = { ...economic, pct: economicFactorPct };
  const rationale = await buildRationale(
    {
      returnType: assembly.returnType,
      cohortSize: assembly.cohortSize,
      price,
      economic: economicUsed,
      signals,
    },
    opts.aiComplete,
  );

  return {
    price,
    economic: economicUsed,
    signals,
    rationale,
    ownActualHoursByTier: assembly.ownActualHoursByTier,
    complexity: assembly.complexity,
    cohortSize: assembly.cohortSize,
    statistic: assembly.statistic,
    returnType: assembly.returnType,
  };
}
