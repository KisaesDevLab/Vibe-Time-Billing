// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { computePrepFeeBasis } from './prep-fee-basis';

describe('computePrepFeeBasis (D11 + D21)', () => {
  const wcTax = 'tax-prep';
  const wcAdvisory = 'advisory';
  const wcBookkeeping = 'bookkeeping';

  it('returns 0 when prepFeeWorkCodeIds is empty (D21 trigger)', () => {
    expect(
      computePrepFeeBasis(
        [
          { workCodeId: wcTax, amountCents: 100000 },
          { workCodeId: wcAdvisory, amountCents: 50000 },
        ],
        [],
      ),
    ).toBe(0);
  });

  it('returns 0 when no line matches (D21 trigger)', () => {
    expect(
      computePrepFeeBasis(
        [
          { workCodeId: wcAdvisory, amountCents: 100000 },
          { workCodeId: wcBookkeeping, amountCents: 50000 },
        ],
        [wcTax],
      ),
    ).toBe(0);
  });

  it('sums only matching lines', () => {
    expect(
      computePrepFeeBasis(
        [
          { workCodeId: wcTax, amountCents: 100000 },
          { workCodeId: wcAdvisory, amountCents: 50000 },
          { workCodeId: wcTax, amountCents: 25000 },
        ],
        [wcTax],
      ),
    ).toBe(125000);
  });

  it('handles multiple prep-fee codes', () => {
    expect(
      computePrepFeeBasis(
        [
          { workCodeId: wcTax, amountCents: 100000 },
          { workCodeId: wcAdvisory, amountCents: 50000 },
          { workCodeId: wcBookkeeping, amountCents: 30000 },
        ],
        [wcTax, wcAdvisory],
      ),
    ).toBe(150000);
  });

  it('ignores lines with null work_code_id', () => {
    expect(
      computePrepFeeBasis(
        [
          { workCodeId: null, amountCents: 100000 },
          { workCodeId: wcTax, amountCents: 50000 },
        ],
        [wcTax],
      ),
    ).toBe(50000);
  });

  it('returns 0 for an empty invoice', () => {
    expect(computePrepFeeBasis([], [wcTax])).toBe(0);
  });
});
