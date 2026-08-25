// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { DOC_TYPES, normalizeDocType, stripPiiFields } from './doc-types';

describe('DOC_TYPES', () => {
  it('is non-empty, unique, and ends in the Other catch-all', () => {
    expect(DOC_TYPES.length).toBeGreaterThan(30);
    expect(new Set(DOC_TYPES).size).toBe(DOC_TYPES.length);
    expect(DOC_TYPES).toContain('Other');
    expect(DOC_TYPES).toContain('K-1-1120S');
  });
});

describe('normalizeDocType', () => {
  it('passes exact vocabulary values through', () => {
    expect(normalizeDocType('W-2')).toBe('W-2');
    expect(normalizeDocType('K-1-1065')).toBe('K-1-1065');
  });
  it('canonicalizes case/punctuation variants', () => {
    expect(normalizeDocType('w2')).toBe('W-2');
    expect(normalizeDocType('1099 NEC')).toBe('1099-NEC');
    expect(normalizeDocType('bank statement')).toBe('Bank-Statement');
  });
  it('maps unknowns to Other and preserves null', () => {
    expect(normalizeDocType('Mystery Form 9999')).toBe('Other');
    expect(normalizeDocType(null)).toBeNull();
    expect(normalizeDocType('   ')).toBeNull();
  });
});

describe('stripPiiFields', () => {
  it('drops fields with SSNs (with and without dashes)', () => {
    expect(stripPiiFields({ issuer: 'Acme 123-45-6789' }).issuer).toBeNull();
    expect(stripPiiFields({ issuer: 'ref 123456789 Corp' }).issuer).toBeNull();
  });
  it('drops fields with EINs and account-like runs', () => {
    expect(stripPiiFields({ issuer: 'EIN 12-3456789' }).issuer).toBeNull();
    expect(stripPiiFields({ period: 'acct 12345678' }).period).toBeNull();
  });
  it('leaves clean fields and non-strings untouched', () => {
    const r = stripPiiFields({ doc_type: 'W-2', year: '2025', n: 3, empty: null });
    expect(r.doc_type).toBe('W-2');
    expect(r.year).toBe('2025');
    expect(r.n).toBe(3);
    expect(r.empty).toBeNull();
  });
  it('does not flag ordinary dates or 4-digit years', () => {
    expect(stripPiiFields({ date: '2025-03-01' }).date).toBe('2025-03-01');
    expect(stripPiiFields({ period: 'FY2023' }).period).toBe('FY2023');
  });
});
