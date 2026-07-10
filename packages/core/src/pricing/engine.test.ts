// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { buildPrice, grossUpByMargin, type PriceInputs } from './engine';

const base: PriceInputs = {
  tiers: [
    { tier: 'PARTNER', expectedHours: 2, burdenedCostRateCents: 15000 }, // $150/h burdened
    { tier: 'STAFF', expectedHours: 8, burdenedCostRateCents: 6000 }, // $60/h burdened
  ],
  targetMarginPct: 40,
  economicFactorPct: 3,
  cohortSize: 12,
  cohortMin: 5,
  priorFeeCents: 100000,
};

describe('pricing engine', () => {
  it('PS-17 — is deterministic (same inputs → same number)', () => {
    expect(buildPrice(base)).toEqual(buildPrice(base));
  });

  it('PS-18 — applies margin by DIVISION (÷0.60), not multiplication (×1.40)', () => {
    const r = buildPrice({ ...base, economicFactorPct: 0 });
    expect(r.costBaseCents).toBe(78000); // 2×15000 + 8×6000
    expect(r.grossedUpCents).toBe(130000); // 78000 / 0.60
    expect(r.grossedUpCents).not.toBe(78000 * 1.4); // 109200 — the wrong markup form
    // The helper itself:
    expect(grossUpByMargin(78000, 40)).toBe(130000);
    expect(grossUpByMargin(60000, 40)).toBe(100000);
  });

  it('PS-19 — cost base is Σ expectedHours × BURDENED cost rate (engine never sees billable)', () => {
    const r = buildPrice(base);
    expect(r.breakdownByTier.map((b) => b.costCents)).toEqual([30000, 48000]);
    expect(r.costBaseCents).toBe(78000);
  });

  it('PS-20 — economic factor applied exactly once, after the gross-up (no double-count)', () => {
    const r = buildPrice(base); // econ 3%
    expect(r.suggestedCents).toBe(Math.round(130000 * 1.03)); // 133900 — applied once
    expect(r.suggestedCents).not.toBe(Math.round(130000 * 1.03 * 1.03)); // not twice
    // Zero economic factor leaves the grossed-up figure unchanged.
    expect(buildPrice({ ...base, economicFactorPct: 0 }).suggestedCents).toBe(130000);
  });

  it('produces a range whose width follows confidence (more cohort → tighter)', () => {
    const high = buildPrice({ ...base, cohortSize: 20 });
    const med = buildPrice({ ...base, cohortSize: 6 });
    expect(high.confidence).toBe('HIGH');
    expect(med.confidence).toBe('MEDIUM');
    expect(high.bandPct).toBeLessThan(med.bandPct);
    expect(high.lowCents).toBeLessThan(high.suggestedCents);
    expect(high.highCents).toBeGreaterThan(high.suggestedCents);
  });

  it('PS-24 — thin cohort falls back to prior-fee × economic, low confidence', () => {
    const r = buildPrice({ ...base, cohortSize: 2, economicFactorPct: 5 });
    expect(r.mode).toBe('PRIOR_FEE_FALLBACK');
    expect(r.suggestedCents).toBe(Math.round(100000 * 1.05)); // prior fee × (1 + econ)
    expect(r.confidence).toBe('LOW');
    expect(r.bandPct).toBe(0.25); // widest
    expect(r.costBaseCents).toBe(0);
  });

  it('rejects an out-of-range margin', () => {
    expect(() => grossUpByMargin(1000, 100)).toThrow();
    expect(() => grossUpByMargin(1000, -1)).toThrow();
  });
});
