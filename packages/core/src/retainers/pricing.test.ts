// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { describe, expect, it } from 'vitest';

import { bankersDivide, computeTierPrice } from './pricing';

describe('computeTierPrice (D10)', () => {
  it('base + 10% of 1500 = base + 150', () => {
    expect(
      computeTierPrice({ baseFeeCents: 25000, pctOfPrepFeeBps: 1000, basisCents: 150000 }),
    ).toBe(40000); // 25000 + (1000 * 150000 / 10000) = 25000 + 15000
  });

  it('base + 0% = base (zero-pct tier)', () => {
    expect(computeTierPrice({ baseFeeCents: 50000, pctOfPrepFeeBps: 0, basisCents: 250000 })).toBe(
      50000,
    );
  });

  it('zero base + 25% of 2000 = 500', () => {
    expect(computeTierPrice({ baseFeeCents: 0, pctOfPrepFeeBps: 2500, basisCents: 200000 })).toBe(
      50000,
    ); // (2500 * 200000) / 10000 = 50000
  });

  it('large basis stays integer (no float drift)', () => {
    // 12.34% of $1,234,567.89 = $152,345.0...
    const result = computeTierPrice({
      baseFeeCents: 0,
      pctOfPrepFeeBps: 1234,
      basisCents: 123456789,
    });
    // exact: 1234 * 123456789 / 10000 = 15234567.81... → banker's → 15234568
    expect(result).toBe(15234568);
  });

  it('rejects negative baseFeeCents', () => {
    expect(() => computeTierPrice({ baseFeeCents: -1, pctOfPrepFeeBps: 0, basisCents: 0 })).toThrow(
      'baseFeeCents',
    );
  });

  it('rejects pct > 10000 bps', () => {
    expect(() =>
      computeTierPrice({ baseFeeCents: 0, pctOfPrepFeeBps: 10001, basisCents: 0 }),
    ).toThrow('pctOfPrepFeeBps');
  });

  it('rejects negative basis', () => {
    expect(() => computeTierPrice({ baseFeeCents: 0, pctOfPrepFeeBps: 0, basisCents: -1 })).toThrow(
      'basisCents',
    );
  });

  it('rejects non-integer inputs', () => {
    expect(() =>
      computeTierPrice({ baseFeeCents: 1.5, pctOfPrepFeeBps: 0, basisCents: 0 }),
    ).toThrow();
  });
});

describe('bankersDivide (half-to-even)', () => {
  it('rounds down when below half', () => {
    expect(bankersDivide(10n, 3n)).toBe(3n); // 3.33...
  });

  it('rounds up when above half', () => {
    expect(bankersDivide(11n, 3n)).toBe(4n); // 3.66...
  });

  it('exact half — rounds to even (down)', () => {
    expect(bankersDivide(5n, 2n)).toBe(2n); // 2.5 → 2 (even)
  });

  it('exact half — rounds to even (up)', () => {
    expect(bankersDivide(7n, 2n)).toBe(4n); // 3.5 → 4 (even)
  });

  it('throws on zero denom', () => {
    expect(() => bankersDivide(1n, 0n)).toThrow();
  });
});
