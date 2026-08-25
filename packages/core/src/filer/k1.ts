// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// K-1 recipient parsing for the Vibe Filer inbox. UltraTax K-1 packages
// are named `<Entity>_<year>_<form>_K1_Package_<Recipient Name>_<ids>.ext`
// (e.g. `Parkway, LLC_2025_1120S_K1_Package_Joe Black_6111_PARK.pdf`).
// The trailing id-like tokens are the ENTITY's UltraTax Client ID —
// never the recipient's — so only the name is extracted here; matching
// against clients is name-only.

import { splitExt } from './parse';

export interface K1Recipient {
  /** Recipient display name as it appears in the filename, e.g. "Joe Black". */
  recipientName: string;
  /** Raw segment after the K1_Package_ marker (diagnostics/tests). */
  raw: string;
}

// Tolerates the marker variants UltraTax emits: K1_Package_, K1 Package_,
// K-1_Package_. Global flag so the LAST occurrence is used (an entity
// literally named "K1 Package LLC" must not shift the split).
const K1_MARKER = /K-?1[ _]Package_/gi;

/**
 * Entity-id-shaped trailing token. Three shapes, deliberately narrow so an
 * upper-cased SURNAME is not eaten (review finding — "Joe_BLACK_6111" must
 * keep BLACK):
 *  - numeric run (>=3 digits): "6111", "123456"
 *  - alphanumeric WITH a digit (case-insensitive): "ALLE1234", "AWS9001"
 *  - short pure-alpha ALL-CAPS (2–4 chars): "PARK" — UltraTax letter codes
 *    are short; surnames of 5+ caps (BLACK, SMITH) survive. A ≤4-letter
 *    all-caps surname with no other trailing ids is the accepted rare
 *    false positive of this heuristic.
 * Lowercase pure-alpha tokens are never treated as ids: a lowercase entity
 * code left on the name only depresses the fuzzy score (no suggestion —
 * staff use Search), which is safer than eating a name particle.
 */
function isIdLikeToken(token: string): boolean {
  return (
    /^\d{3,}$/.test(token) ||
    (/^[A-Za-z0-9]{2,12}$/.test(token) && /\d/.test(token)) ||
    /^[A-Z]{2,4}$/.test(token)
  );
}

/**
 * Extract the K-1 recipient name from a filename, or null when the file
 * is not a K-1 package (no marker) or no usable name follows the marker.
 */
export function parseK1Recipient(filename: string): K1Recipient | null {
  const { stem } = splitExt(filename);

  let markerEnd = -1;
  for (const m of stem.matchAll(K1_MARKER)) {
    if (m.index !== undefined) markerEnd = m.index + m[0].length;
  }
  if (markerEnd < 0 || markerEnd >= stem.length) return null;

  const raw = stem.slice(markerEnd);
  const tokens = raw.split('_').map((t) => t.trim());

  // Walk from the end, discarding entity-id-shaped tokens until a token
  // that reads like a name stops the walk.
  let nameEnd = tokens.length;
  while (nameEnd > 1 && isIdLikeToken(tokens[nameEnd - 1]!)) nameEnd -= 1;

  const recipientName = tokens.slice(0, nameEnd).join(' ').trim();
  if (recipientName.length === 0) return null;
  // A lone id-shaped token is not a recipient name.
  if (nameEnd === 1 && isIdLikeToken(tokens[0]!)) return null;

  return { recipientName, raw };
}

// Grammar kept in sync with the repo's other name matchers (review
// finding: three sibling grammars had drifted at birth). Suffix list
// mirrors packages/storage/src/normalize.ts BUSINESS_SUFFIXES; the
// spouse markers mirror packages/core/src/storage/onboarding.ts
// SPOUSE_MARKERS ("and family/wife/husband/spouse" name nobody — they
// collapse rather than expand). @vibe/core cannot import @vibe/storage,
// so the lists live here with this pointer instead of a shared module.
const ENTITY_SUFFIX_RE =
  /^(llc|l\.l\.c\.|pllc|inc\.?|incorporated|ltd\.?|limited|llp|l\.l\.p\.|lp|lllp|pc|p\.c\.|pa|p\.a\.|ps|corp\.?|corporation|co\.?|company)$/i;
const SPOUSE_COLLAPSE_RE = /\s*(?:&\s*spouse|\band\s+(?:family|wife|husband|spouse))\b\s*$/i;

/**
 * Expand a stored client name into name variants comparable with the
 * `First Last` names UltraTax writes into filenames. Client records are
 * mostly `Last, First` and may include a spouse:
 *   "Black, Joe"            → ["Joe Black"]
 *   "Black, Joe & Jane"     → ["Joe Black", "Jane Black"]
 *   "Black, Joe and family" → ["Joe Black"]  (marker names nobody)
 *   "Parkway, LLC"          → ["Parkway, LLC"]  (suffix, not a given name)
 *   no comma                → [name] as-is
 */
export function clientNameVariants(name: string): string[] {
  const trimmed = name.trim();
  const comma = trimmed.indexOf(',');
  if (comma <= 0 || comma === trimmed.length - 1) return [trimmed];

  const last = trimmed.slice(0, comma).trim();
  const givenPart = trimmed
    .slice(comma + 1)
    .trim()
    .replace(SPOUSE_COLLAPSE_RE, '');
  if (last.length === 0 || givenPart.length === 0) return [trimmed];

  // Entity suffixes after the comma ("Parkway, LLC") are not given names.
  if (ENTITY_SUFFIX_RE.test(givenPart)) return [trimmed];

  const givens = givenPart
    .split(/\s*(?:&|\band\b)\s*/i)
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
  if (givens.length === 0) return [trimmed];

  return givens.map((g) => `${g} ${last}`);
}
