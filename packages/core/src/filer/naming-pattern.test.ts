// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NAMING_PATTERN,
  composeFilename,
  fillPattern,
  validatePattern,
  type NamingFields,
} from './naming-pattern';

const base: NamingFields = { client: 'Smith John', original: 'scan0023' };

describe('fillPattern', () => {
  it('fills every slot', () => {
    expect(
      fillPattern(DEFAULT_NAMING_PATTERN, {
        ...base,
        year: '2024',
        doc_type: 'W-2',
        issuer: 'Acme Corp',
      }),
    ).toBe('2024 W-2 - Acme Corp - Smith John');
  });

  it('collapses separators around empty slots', () => {
    expect(fillPattern(DEFAULT_NAMING_PATTERN, { ...base, year: '2024', doc_type: 'W-2' })).toBe(
      '2024 W-2 - Smith John',
    );
    expect(fillPattern(DEFAULT_NAMING_PATTERN, { ...base, doc_type: 'Bank Statement' })).toBe(
      'Bank Statement - Smith John',
    );
    expect(fillPattern('{client} - {doc_type}', { ...base })).toBe('Smith John');
  });

  it('falls back to the original stem when nothing fills', () => {
    expect(fillPattern('{year} {doc_type}', base)).toBe('scan0023');
  });

  it('strips characters that are illegal in filenames', () => {
    expect(fillPattern('{doc_type}', { ...base, doc_type: 'W-2: copy/b?' })).toBe('W-2 copy b');
  });

  it('truncates at a word boundary', () => {
    const long = 'word '.repeat(40).trim();
    const out = fillPattern('{doc_type}', { ...base, doc_type: long }, { maxStemLength: 30 });
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith('word')).toBe(true);
  });

  it('keeps literal text that follows the last slot', () => {
    expect(fillPattern('{client} (copy)', base)).toBe('Smith John (copy)');
  });
});

describe('composeFilename', () => {
  it('keeps the original extension, lower-cased', () => {
    expect(
      composeFilename(
        DEFAULT_NAMING_PATTERN,
        { ...base, year: '2023', doc_type: '1099' },
        'IMG.PDF',
      ),
    ).toBe('2023 1099 - Smith John.pdf');
  });
  it('handles files without an extension and derives the original stem', () => {
    expect(composeFilename('{original}', { ...base, original: '' }, 'README')).toBe('README');
    expect(composeFilename('{original}', { ...base, original: '' }, 'notes.final.txt')).toBe(
      'notes.final.txt',
    );
  });
});

describe('validatePattern', () => {
  it('accepts the default and rejects bad ones', () => {
    expect(validatePattern(DEFAULT_NAMING_PATTERN)).toEqual({ ok: true });
    expect(validatePattern('')).toEqual({ ok: false, error: 'pattern_empty' });
    expect(validatePattern('no slots here')).toEqual({ ok: false, error: 'pattern_has_no_slots' });
    expect(validatePattern('{bogus}')).toEqual({ ok: false, error: 'unknown_slot:bogus' });
    expect(validatePattern('{year}/{client}')).toEqual({
      ok: false,
      error: 'pattern_has_illegal_characters',
    });
    expect(validatePattern('{year}' + 'x'.repeat(130)).ok).toBe(false);
  });
});
