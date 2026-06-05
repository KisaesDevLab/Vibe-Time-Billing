// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase 4 — validatePlacements unit coverage: the authoritative coord +
// page + per-signer-signature rules, independent of the HTTP layer.

import { describe, expect, it } from 'vitest';

import { validatePlacements } from '../signatures/validation';

const GEO = [
  { pageNumber: 1, widthPt: 612, heightPt: 792 },
  { pageNumber: 2, widthPt: 612, heightPt: 792 },
];

function sig(signerId: string, over: Record<string, unknown> = {}) {
  return {
    signerId,
    fieldType: 'signature' as const,
    pageNumber: 1,
    nx: 0.1,
    ny: 0.1,
    nw: 0.2,
    nh: 0.05,
    ...over,
  };
}

describe('validatePlacements', () => {
  it('passes a valid set where every signer has a signature field', () => {
    expect(validatePlacements(['a', 'b'], [sig('a'), sig('b', { pageNumber: 2 })], GEO)).toEqual(
      [],
    );
  });

  it('requires geometry', () => {
    const errs = validatePlacements(['a'], [sig('a')], null);
    expect(errs).toEqual([{ path: 'geometry', message: 'geometry_required' }]);
  });

  it('flags unknown signer, missing page, and out-of-page bounds', () => {
    const errs = validatePlacements(
      ['a'],
      [
        sig('ghost'), // unknown signer (and 'a' ends up with no signature)
        sig('a', { pageNumber: 9 }),
        sig('a', { nx: 0.95, nw: 0.2 }), // extends past width
        sig('a', { ny: 0.97, nh: 0.1 }), // extends past height
      ],
      GEO,
    );
    const messages = errs.map((e) => e.message);
    expect(messages).toContain('unknown_signer');
    expect(messages).toContain('page_not_in_document');
    expect(messages).toContain('extends_past_page_width');
    expect(messages).toContain('extends_past_page_height');
  });

  it('flags a signer with only non-signature fields', () => {
    const errs = validatePlacements(['a'], [{ ...sig('a'), fieldType: 'date' }], GEO);
    expect(errs.some((e) => e.message === 'signer_has_no_signature_field')).toBe(true);
  });

  it('flags coords outside [0,1]', () => {
    const errs = validatePlacements(['a'], [sig('a', { nx: -0.1 }), sig('a', { ny: 1.5 })], GEO);
    expect(errs.filter((e) => e.message === 'out_of_unit_range').length).toBeGreaterThanOrEqual(2);
  });
});
