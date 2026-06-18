// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import { generateBookingSlug, normalizeCustomSlug } from '../appointments/booking-slug';

describe('generateBookingSlug', () => {
  it('produces the requested length using only unambiguous chars', () => {
    for (let i = 0; i < 200; i++) {
      const s = generateBookingSlug();
      expect(s).toHaveLength(7);
      expect(s).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]+$/);
      expect(s).not.toMatch(/[01ILOU]/);
    }
  });

  it('is effectively unique across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(generateBookingSlug());
    // 30^7 keyspace → 5000 draws should essentially never collide.
    expect(seen.size).toBeGreaterThan(4995);
  });
});

describe('normalizeCustomSlug', () => {
  it('accepts and lowercases valid slugs', () => {
    expect(normalizeCustomSlug('Kurt-Consult')).toBe('kurt-consult');
    expect(normalizeCustomSlug('  smith2025 ')).toBe('smith2025');
  });

  it('rejects invalid slugs', () => {
    expect(normalizeCustomSlug('a')).toBeNull(); // too short
    expect(normalizeCustomSlug('-lead')).toBeNull(); // leading hyphen
    expect(normalizeCustomSlug('trail-')).toBeNull(); // trailing hyphen
    expect(normalizeCustomSlug('has space')).toBeNull();
    expect(normalizeCustomSlug('bad_underscore')).toBeNull();
    expect(normalizeCustomSlug('a'.repeat(51))).toBeNull(); // too long
  });
});
