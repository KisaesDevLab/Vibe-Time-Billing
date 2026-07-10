// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Short, human-typeable slugs for public booking links (0168). Auto codes
// use an unambiguous alphabet (no 0/1/I/L/O/U) so a slug pasted into a text
// can't be mis-keyed; staff may also set a custom lowercase slug. Uniqueness
// is enforced by the staff_public_booking_link_slug_uk index — callers retry
// generateBookingSlug() on a unique-violation.

import { randomBytes } from 'node:crypto';

// 30 unambiguous chars: digits 2-9 + A-Z minus I, L, O, U.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEFAULT_LENGTH = 7;

/** A random, unambiguous short code (default 7 chars → ~22 billion values). */
export function generateBookingSlug(length: number = DEFAULT_LENGTH): string {
  const n = ALPHABET.length;
  // Rejection sampling removes modulo bias (256 is not a multiple of 30).
  const max = Math.floor(256 / n) * n;
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= max) continue;
      out += ALPHABET[b % n];
      if (out.length === length) break;
    }
  }
  return out;
}

// Custom slugs: lowercase url-safe, 2-50 chars, hyphens allowed but not at
// the ends. Returns the normalized slug, or null if invalid.
const CUSTOM_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export function normalizeCustomSlug(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (s.length < 2 || s.length > 50) return null;
  return CUSTOM_SLUG_RE.test(s) ? s : null;
}
