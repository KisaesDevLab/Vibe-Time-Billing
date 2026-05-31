// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Connect I.4 — tax-id hash helper + verify path. Verifies the
// normalization rules, the pepper gate, and constant-time compare.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { hashTaxId, isFeatureEnabled, normalizeTaxId, verifyTaxId } from '../portal/tax-id';

const ORIGINAL_PEPPER = process.env['TAX_ID_HASH_PEPPER'];

beforeEach(() => {
  process.env['TAX_ID_HASH_PEPPER'] = 'pepper-must-be-16-chars-or-more';
});

afterEach(() => {
  if (ORIGINAL_PEPPER === undefined) delete process.env['TAX_ID_HASH_PEPPER'];
  else process.env['TAX_ID_HASH_PEPPER'] = ORIGINAL_PEPPER;
});

describe('normalizeTaxId', () => {
  it('accepts 4 digits for ssn_last4', () => {
    expect(normalizeTaxId('ssn_last4', '1234')).toEqual({ ok: true, digits: '1234' });
  });

  it('rejects 3 digits for ssn_last4', () => {
    expect(normalizeTaxId('ssn_last4', '123')).toEqual({ ok: false, error: 'wrong_length' });
  });

  it('accepts EIN with or without dash', () => {
    expect(normalizeTaxId('ein', '12-3456789')).toEqual({ ok: true, digits: '123456789' });
    expect(normalizeTaxId('ein', '123456789')).toEqual({ ok: true, digits: '123456789' });
  });

  it('rejects EIN with embedded letters', () => {
    expect(normalizeTaxId('ein', '12-34567XY')).toEqual({ ok: false, error: 'non_digit' });
  });

  it('rejects 8-digit EIN', () => {
    expect(normalizeTaxId('ein', '12345678')).toEqual({ ok: false, error: 'wrong_length' });
  });
});

describe('hashTaxId / verifyTaxId', () => {
  it('round-trips for ssn_last4', () => {
    const hash = hashTaxId('ssn_last4', '1234');
    expect(verifyTaxId('ssn_last4', '1234', hash)).toBe(true);
    expect(verifyTaxId('ssn_last4', '4321', hash)).toBe(false);
  });

  it('round-trips for ein with formatting tolerance', () => {
    const hash = hashTaxId('ein', '123456789');
    expect(verifyTaxId('ein', '12-3456789', hash)).toBe(true);
    expect(verifyTaxId('ein', '123-45-6789', hash)).toBe(true);
    expect(verifyTaxId('ein', '987654321', hash)).toBe(false);
  });

  it('kind change → different hash', () => {
    const ssn = hashTaxId('ssn_last4', '1234');
    // Same 4 digits hashed as a (truncated) EIN would fail normalization,
    // but conceptually the kind label tags into the HMAC so even
    // identical digits produce different output across kinds.
    const ein = hashTaxId('ein', '123412341');
    expect(ssn).not.toBe(ein);
  });

  it('verify returns false when pepper is unset', () => {
    const hash = hashTaxId('ssn_last4', '1234');
    delete process.env['TAX_ID_HASH_PEPPER'];
    expect(isFeatureEnabled()).toBe(false);
    expect(verifyTaxId('ssn_last4', '1234', hash)).toBe(false);
  });

  it('verify returns false on malformed raw value', () => {
    const hash = hashTaxId('ssn_last4', '1234');
    expect(verifyTaxId('ssn_last4', 'abc', hash)).toBe(false);
    expect(verifyTaxId('ssn_last4', '12', hash)).toBe(false);
  });

  it('hashTaxId throws when pepper too short / missing', () => {
    delete process.env['TAX_ID_HASH_PEPPER'];
    expect(() => hashTaxId('ssn_last4', '1234')).toThrow();
    process.env['TAX_ID_HASH_PEPPER'] = 'too-short';
    expect(() => hashTaxId('ssn_last4', '1234')).toThrow();
  });
});
