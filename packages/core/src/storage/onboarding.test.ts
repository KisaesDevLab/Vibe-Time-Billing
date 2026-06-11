// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';

import {
  levenshtein,
  nameSimilarity,
  normalizeName,
  parseTaxSoftwareId,
  scoreFolderMatches,
  type ClientForMatching,
} from './onboarding';

describe('normalizeName', () => {
  it('reorders "Last, First" → "First Last"', () => {
    expect(normalizeName('Smith, John')).toBe('john smith');
  });

  it('strips spouse markers', () => {
    expect(normalizeName('Smith, John & spouse')).toBe('john smith');
    expect(normalizeName('Acme Corp and family')).toBe('acme corp');
  });

  it('lowercases + strips punctuation', () => {
    expect(normalizeName('Smith-Jones, John')).toBe('john smith jones');
    expect(normalizeName('  Acme   Inc.  ')).toBe('acme inc');
  });

  it('leaves multi-comma names alone (e.g. "Smith, Jones, & Co")', () => {
    // Two commas — don't reorder; just strip + collapse.
    const result = normalizeName('Smith, Jones, & Co');
    expect(result).toBe('smith jones co');
  });
});

describe('parseTaxSoftwareId', () => {
  it('extracts numeric IDs from "0042 - Name"', () => {
    expect(parseTaxSoftwareId('0042 - Smith, John')).toBe('0042');
    expect(parseTaxSoftwareId('0042-Smith, John')).toBe('0042');
  });

  it('extracts alphanumeric IDs from bracketed prefixes', () => {
    expect(parseTaxSoftwareId('[A123] Acme LLC')).toBe('A123');
    expect(parseTaxSoftwareId('[CL-9] Beta Co')).toBe('CL-9');
  });

  it('returns null when no recognizable prefix', () => {
    expect(parseTaxSoftwareId('Acme LLC')).toBeNull();
    expect(parseTaxSoftwareId('Smith and Co')).toBeNull();
  });

  it('rejects ordinary words as ids', () => {
    expect(parseTaxSoftwareId('Smith - Acme Co')).toBeNull();
  });

  it('handles trailing slash on folder names', () => {
    expect(parseTaxSoftwareId('0042 - Smith/')).toBe('0042');
  });
});

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('returns length for empty vs non-empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts simple substitutions', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('is symmetric', () => {
    expect(levenshtein('abc', 'xyzabc')).toBe(levenshtein('xyzabc', 'abc'));
  });
});

describe('nameSimilarity', () => {
  it('returns 1 for exact normalized match', () => {
    expect(nameSimilarity('Smith, John', 'John Smith')).toBe(1);
  });

  it('returns 0 for empty input', () => {
    expect(nameSimilarity('', 'anything')).toBe(0);
  });

  it('falls in [0, 1] for plausible near-matches', () => {
    const s = nameSimilarity('Smith, John & Mary', 'John Smith');
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(1);
  });
});

describe('scoreFolderMatches', () => {
  const clients: ClientForMatching[] = [
    { id: 'c-smith', name: 'Smith, John', taxSoftwareId: '0042' },
    { id: 'c-acme', name: 'Acme LLC', clientFacingName: 'Acme Holdings' },
    { id: 'c-beta', name: 'Beta Co', taxSoftwareId: 'A123' },
    { id: 'c-other', name: 'Wholly Unrelated' },
  ];

  it('returns 1.0 for an exact tax_software_id match', () => {
    const result = scoreFolderMatches('0042 - Smith, John', clients);
    expect(result[0]).toEqual({
      clientId: 'c-smith',
      confidence: 1,
      reason: 'tax_software_id',
    });
  });

  it('falls back to normalized-name match when no tax id', () => {
    const result = scoreFolderMatches('Smith, John', clients);
    expect(result[0]?.clientId).toBe('c-smith');
    expect(result[0]?.reason).toBe('normalized_name');
    expect(result[0]?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result[0]?.confidence).toBeLessThanOrEqual(0.95);
  });

  it('considers clientFacingName as a candidate', () => {
    const result = scoreFolderMatches('Acme Holdings', clients);
    expect(result[0]?.clientId).toBe('c-acme');
  });

  it('drops candidates below the name floor', () => {
    const result = scoreFolderMatches('Zzz Nothing', clients);
    expect(result).toHaveLength(0);
  });

  it('caps results at topN', () => {
    const result = scoreFolderMatches('0042 - Smith', clients, { topN: 2 });
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('does not double-count when both signals hit', () => {
    // Tax-id wins; the client should appear once with confidence 1.0.
    const result = scoreFolderMatches('0042 - Smith, John', clients);
    const smithEntries = result.filter((r) => r.clientId === 'c-smith');
    expect(smithEntries).toHaveLength(1);
    expect(smithEntries[0]?.confidence).toBe(1);
  });
});
