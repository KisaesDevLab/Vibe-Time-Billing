// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// FMv2 Phase A — normalize.ts tests.

import { describe, expect, it } from 'vitest';
import {
  LOW_SIGNAL_TOKENS,
  extractTaxId,
  normalizeName,
  normalizeNameString,
  significantTokens,
  stripSpouseMarkers,
  stripTaxIdPrefix,
} from '../normalize';

describe('FMv2 — extractTaxId', () => {
  it('captures bracketed prefix', () => {
    expect(extractTaxId('[0042] Smith, John')).toBe('0042');
    expect(extractTaxId('[A123] Acme LLC')).toBe('A123');
  });

  it('captures leading "0042 - rest"', () => {
    expect(extractTaxId('0042 - Smith, John')).toBe('0042');
  });

  it('captures leading "0042-rest"', () => {
    expect(extractTaxId('0042-Smith, John')).toBe('0042');
  });

  it('captures alphanumeric IDs', () => {
    expect(extractTaxId('A123 - Foo')).toBe('A123');
    expect(extractTaxId('A123-Foo')).toBe('A123');
  });

  it('returns null when no ID prefix', () => {
    expect(extractTaxId('Smith, John')).toBeNull();
    expect(extractTaxId('Acme LLC')).toBeNull();
  });

  it('rejects short pure-alpha tokens (Smith - Acme)', () => {
    expect(extractTaxId('Smith - Acme')).toBeNull();
  });

  it('strips trailing slash', () => {
    expect(extractTaxId('0042 - Smith/')).toBe('0042');
  });
});

describe('FMv2 — stripTaxIdPrefix', () => {
  it('removes [id] prefix', () => {
    expect(stripTaxIdPrefix('[0042] Smith, John')).toBe('Smith, John');
  });

  it('removes "0042 - " prefix', () => {
    expect(stripTaxIdPrefix('0042 - Smith, John')).toBe('Smith, John');
  });

  it('removes "0042-" prefix', () => {
    expect(stripTaxIdPrefix('0042-Smith, John')).toBe('Smith, John');
  });

  it('passes through when no prefix', () => {
    expect(stripTaxIdPrefix('Smith, John')).toBe('Smith, John');
  });
});

describe('FMv2 — stripSpouseMarkers', () => {
  it('strips "& spouse" at end', () => {
    expect(stripSpouseMarkers('smith & spouse')).toBe('smith');
  });

  it('strips "and Mary" at end', () => {
    expect(stripSpouseMarkers('smith and mary')).toBe('smith');
  });

  it('strips "and family" at end', () => {
    expect(stripSpouseMarkers('smith and family')).toBe('smith');
  });

  it('leaves "& X" inline unless at end of string', () => {
    // "& jones" isn't at end (llc follows), so spouse-marker regex
    // doesn't fire. Inline conversion to space happens later in the
    // full normalizeName pipeline via the punctuation step.
    expect(stripSpouseMarkers('smith & jones llc')).toBe('smith & jones llc');
  });
});

describe('FMv2 — normalizeName (full pipeline)', () => {
  it('"Smith, John & Mary" → ["smith", "john"]', () => {
    expect(normalizeName('Smith, John & Mary')).toEqual(['smith', 'john']);
  });

  it('"Smith Family" → ["smith", "family"]', () => {
    expect(normalizeName('Smith Family')).toEqual(['smith', 'family']);
  });

  it('preserves Last-First order from comma form', () => {
    expect(normalizeName('Smith, John')).toEqual(['smith', 'john']);
  });

  it('preserves First-Last order when no comma', () => {
    expect(normalizeName('John Smith')).toEqual(['john', 'smith']);
  });

  it('strips business suffixes — Acme LLC → ["acme"]', () => {
    expect(normalizeName('Acme LLC')).toEqual(['acme']);
  });

  it('strips business suffixes — Vance Industries Inc → ["vance", "industries"]', () => {
    expect(normalizeName('Vance Industries Inc')).toEqual(['vance', 'industries']);
  });

  it('strips "The" prefix-suffix article', () => {
    expect(normalizeName('The Wright Company')).toEqual(['wright']);
  });

  it('drops single-letter middle initials', () => {
    expect(normalizeName('John A Smith')).toEqual(['john', 'smith']);
  });

  it('handles trailing slash', () => {
    expect(normalizeName('Smith/')).toEqual(['smith']);
  });

  it('strips _Vibe/ references', () => {
    expect(normalizeName('Smith/_Vibe/')).toEqual(['smith']);
    expect(normalizeName('Smith/_Vibe/client.json')).toEqual(['smith']);
  });

  it('strips tax ID prefix', () => {
    expect(normalizeName('0042 - Smith, John')).toEqual(['smith', 'john']);
    expect(normalizeName('[0042] Smith, John')).toEqual(['smith', 'john']);
  });

  it('handles spousal "and Mary" at end', () => {
    expect(normalizeName('Smith, John and Mary')).toEqual(['smith', 'john']);
  });

  it('handles plus-spouse', () => {
    expect(normalizeName('Smith, John plus spouse')).toEqual(['smith', 'john']);
  });

  it('punctuation + business-suffix strip', () => {
    // Apostrophe → space splits "O'Brien" → 'o brien'; 'o' is < 2
    // chars so it's dropped. "& Sons" isn't at end (LLC follows), so
    // not stripped as spouse marker. "LLC" is dropped as business
    // suffix. End result: ['brien','sons'].
    expect(normalizeName("O'Brien & Sons, LLC")).toEqual(['brien', 'sons']);
  });

  it('idempotent on already-normalized output', () => {
    const once = normalizeNameString('Smith, John & Mary');
    const twice = normalizeNameString(once);
    expect(twice).toBe(once);
  });

  it('empty / whitespace input → []', () => {
    expect(normalizeName('')).toEqual([]);
    expect(normalizeName('   ')).toEqual([]);
  });
});

describe('FMv2 — significantTokens', () => {
  it('drops low-signal stopwords', () => {
    expect(significantTokens(['smith', 'family'])).toEqual(['smith']);
    expect(significantTokens(['family', 'taxes', 'docs'])).toEqual([]);
  });

  it('LOW_SIGNAL_TOKENS contains expected stopwords', () => {
    for (const w of ['family', 'personal', 'taxes', 'tax', 'clients']) {
      expect(LOW_SIGNAL_TOKENS.has(w)).toBe(true);
    }
  });
});
