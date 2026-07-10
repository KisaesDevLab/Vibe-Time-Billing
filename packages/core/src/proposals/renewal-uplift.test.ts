// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0

import { describe, expect, it } from 'vitest';

import { cpiIndexedUplift, manualPercentUplift, realizationBasedUplift } from './renewal-uplift';

describe('manualPercentUplift', () => {
  it('+5% on $1000 → $1050', () => {
    const r = manualPercentUplift(100_000, 500);
    expect(r.upliftBps).toBe(500);
    expect(r.suggestedTotalCents).toBe(105_000);
  });
  it('-5% on $1000 → $950', () => {
    const r = manualPercentUplift(100_000, -500);
    expect(r.suggestedTotalCents).toBe(95_000);
  });
  it('floors at 0 on extreme negative', () => {
    const r = manualPercentUplift(100_000, -200_000);
    expect(r.suggestedTotalCents).toBe(0);
  });
});

describe('realizationBasedUplift', () => {
  it('realization 80% vs target 100% → +25% uplift', () => {
    const r = realizationBasedUplift({
      currentTotalCents: 100_000,
      priorBilledCents: 80_000,
      priorBillableCents: 100_000,
    });
    expect(r.upliftBps).toBe(2_500);
    expect(r.suggestedTotalCents).toBe(125_000);
  });
  it('realization at target → 0 uplift', () => {
    const r = realizationBasedUplift({
      currentTotalCents: 50_000,
      priorBilledCents: 50_000,
      priorBillableCents: 50_000,
    });
    expect(r.upliftBps).toBe(0);
    expect(r.suggestedTotalCents).toBe(50_000);
  });
  it('realization above target → 0 uplift (no auto-cut)', () => {
    const r = realizationBasedUplift({
      currentTotalCents: 50_000,
      priorBilledCents: 60_000,
      priorBillableCents: 50_000,
    });
    expect(r.upliftBps).toBe(0);
  });
  it('missing prior data → 0 uplift', () => {
    const r = realizationBasedUplift({
      currentTotalCents: 50_000,
      priorBilledCents: 0,
      priorBillableCents: 0,
    });
    expect(r.upliftBps).toBe(0);
  });
  it('honors custom target', () => {
    // target 90% (9000 bps), realization 60% → uplift = (9000-6000)/6000 = 0.5 = 5000 bps
    const r = realizationBasedUplift({
      currentTotalCents: 100_000,
      priorBilledCents: 60_000,
      priorBillableCents: 100_000,
      targetRealizationBps: 9_000,
    });
    expect(r.upliftBps).toBe(5_000);
    expect(r.suggestedTotalCents).toBe(150_000);
  });
});

describe('cpiIndexedUplift', () => {
  it('+3% CPI YoY → +3% uplift', () => {
    const r = cpiIndexedUplift(100_000, {
      series: 'CUUR0000SA0',
      currentValue: 309.685,
      currentPeriod: '2026-04',
      priorValue: 300.665,
      priorPeriod: '2025-04',
      fetchedAt: '2026-05-25T00:00:00Z',
    });
    // (309.685 - 300.665) / 300.665 = 0.030003... = ~300 bps
    expect(r.upliftBps).toBeGreaterThanOrEqual(298);
    expect(r.upliftBps).toBeLessThanOrEqual(302);
    expect(r.suggestedTotalCents).toBeGreaterThanOrEqual(102_980);
    expect(r.suggestedTotalCents).toBeLessThanOrEqual(103_020);
  });
  it('CPI deflation → negative uplift', () => {
    const r = cpiIndexedUplift(100_000, {
      series: 'CUUR0000SA0',
      currentValue: 297.0,
      currentPeriod: '2026-04',
      priorValue: 300.0,
      priorPeriod: '2025-04',
      fetchedAt: '2026-05-25T00:00:00Z',
    });
    expect(r.upliftBps).toBe(-100); // -1.00%
    expect(r.suggestedTotalCents).toBe(99_000);
  });
  it('zero prior CPI → 0 uplift fallback', () => {
    const r = cpiIndexedUplift(100_000, {
      series: 'CUUR0000SA0',
      currentValue: 100,
      currentPeriod: '2026-04',
      priorValue: 0,
      priorPeriod: '2025-04',
      fetchedAt: '2026-05-25T00:00:00Z',
    });
    expect(r.upliftBps).toBe(0);
  });
});
