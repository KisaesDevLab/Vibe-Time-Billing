// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { describe, expect, it } from 'vitest';

import { addYears, computeExpiryDate } from './expiry';

describe('computeExpiryDate (D3)', () => {
  it('uses extended_due_date when present', () => {
    expect(
      computeExpiryDate({ originalDueDate: '2026-04-15', extendedDueDate: '2026-10-15' }),
    ).toBe('2029-10-15');
  });

  it('falls back to original_due_date when extended is null', () => {
    expect(computeExpiryDate({ originalDueDate: '2026-04-15', extendedDueDate: null })).toBe(
      '2029-04-15',
    );
  });

  it('throws when both inputs are null', () => {
    expect(() => computeExpiryDate({ originalDueDate: null, extendedDueDate: null })).toThrow(
      'at least one of',
    );
  });
});

describe('addYears', () => {
  it('plain year add', () => {
    expect(addYears('2026-04-15', 3)).toBe('2029-04-15');
  });

  it('leap-day clamps to Feb 28 in non-leap result year', () => {
    expect(addYears('2024-02-29', 3)).toBe('2027-02-28');
  });

  it('leap-day stays Feb 29 in leap result year', () => {
    expect(addYears('2024-02-29', 4)).toBe('2028-02-29');
  });

  it('Jan 31 + 1y → Jan 31 (same length month)', () => {
    expect(addYears('2024-01-31', 1)).toBe('2025-01-31');
  });

  it('throws on malformed ISO', () => {
    expect(() => addYears('not-a-date', 1)).toThrow();
  });
});
