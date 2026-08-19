// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0

import { describe, expect, it } from 'vitest';

import { normalizeFilingStatus } from '../lib/filing-status';

describe('normalizeFilingStatus', () => {
  it('accepts codes and the spelled-out labels tax software emits', () => {
    expect(normalizeFilingStatus('SINGLE')).toBe('SINGLE');
    expect(normalizeFilingStatus('Single')).toBe('SINGLE');
    expect(normalizeFilingStatus('mfj')).toBe('MFJ');
    // UltraTax data mining
    expect(normalizeFilingStatus('Married filing joint')).toBe('MFJ');
    expect(normalizeFilingStatus('Head of household')).toBe('HOH');
    // OCR'd General Information screen / IRS wording
    expect(normalizeFilingStatus('Married filing jointly')).toBe('MFJ');
    expect(normalizeFilingStatus('Married filing separately')).toBe('MFS');
    expect(normalizeFilingStatus('Qualifying surviving spouse')).toBe('QW');
    expect(normalizeFilingStatus('Qualifying widow(er)')).toBe('QW');
  });
  it('returns undefined for blank or unknown values', () => {
    expect(normalizeFilingStatus('')).toBeUndefined();
    expect(normalizeFilingStatus(null)).toBeUndefined();
    expect(normalizeFilingStatus('Corporation')).toBeUndefined();
  });
});
