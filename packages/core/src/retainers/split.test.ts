// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { computeSplit } from './split';

describe('computeSplit (D1)', () => {
  it('under: 2h entry against 10h purchased, 3h consumed → 2h applied, 0h spillover', () => {
    expect(computeSplit({ entryHours: 2, hoursPurchased: 10, hoursConsumed: 3 })).toEqual({
      applied: 2,
      spillover: 0,
      willExhaust: false,
    });
  });

  it('exact: 7h entry exhausts retainer with 10h purchased, 3h consumed', () => {
    expect(computeSplit({ entryHours: 7, hoursPurchased: 10, hoursConsumed: 3 })).toEqual({
      applied: 7,
      spillover: 0,
      willExhaust: true,
    });
  });

  it('over: 10h entry against 10h purchased, 3h consumed → 7h applied, 3h spillover', () => {
    expect(computeSplit({ entryHours: 10, hoursPurchased: 10, hoursConsumed: 3 })).toEqual({
      applied: 7,
      spillover: 3,
      willExhaust: true,
    });
  });

  it('already exhausted: 5h entry against 10h purchased, 10h consumed → 0h applied, 5h spillover', () => {
    expect(computeSplit({ entryHours: 5, hoursPurchased: 10, hoursConsumed: 10 })).toEqual({
      applied: 0,
      spillover: 5,
      willExhaust: false, // already exhausted; this entry doesn't *change* the state
    });
  });

  it('decimal hours: 1.75h entry, 2.50h remaining → 1.75h applied', () => {
    expect(computeSplit({ entryHours: 1.75, hoursPurchased: 5, hoursConsumed: 2.5 })).toEqual({
      applied: 1.75,
      spillover: 0,
      willExhaust: false,
    });
  });

  it('decimal hours: 0.75h entry exhausts retainer (10 - 9.25 = 0.75)', () => {
    expect(computeSplit({ entryHours: 0.75, hoursPurchased: 10, hoursConsumed: 9.25 })).toEqual({
      applied: 0.75,
      spillover: 0,
      willExhaust: true,
    });
  });

  it('decimal float boundary: 0.1 + 0.2 floating-point safe', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE 754. The toCents/fromCents
    // round trip must mask this. Entry of 0.3h against 0.3h purchased
    // (consumed=0) should produce applied=0.3, willExhaust=true.
    const r = computeSplit({ entryHours: 0.1 + 0.2, hoursPurchased: 0.3, hoursConsumed: 0 });
    expect(r.applied).toBe(0.3);
    expect(r.spillover).toBe(0);
    expect(r.willExhaust).toBe(true);
  });

  it('throws on zero entryHours', () => {
    expect(() => computeSplit({ entryHours: 0, hoursPurchased: 10, hoursConsumed: 0 })).toThrow();
  });

  it('throws on negative entryHours', () => {
    expect(() => computeSplit({ entryHours: -1, hoursPurchased: 10, hoursConsumed: 0 })).toThrow();
  });
});
