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

/** Numeric run (>=3) or short all-caps alphanumeric token — id-shaped. */
function isIdLikeToken(token: string): boolean {
  return /^\d{3,}$/.test(token) || /^[A-Z0-9]{2,12}$/.test(token);
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

/**
 * Expand a stored client name into name variants comparable with the
 * `First Last` names UltraTax writes into filenames. Client records are
 * mostly `Last, First` and may include a spouse:
 *   "Black, Joe"        → ["Joe Black"]
 *   "Black, Joe & Jane" → ["Joe Black", "Jane Black"]
 *   "Parkway, LLC"      → ["Parkway, LLC"]  (suffix, not a given name)
 *   no comma            → [name] as-is
 */
export function clientNameVariants(name: string): string[] {
  const trimmed = name.trim();
  const comma = trimmed.indexOf(',');
  if (comma <= 0 || comma === trimmed.length - 1) return [trimmed];

  const last = trimmed.slice(0, comma).trim();
  const givenPart = trimmed.slice(comma + 1).trim();
  if (last.length === 0 || givenPart.length === 0) return [trimmed];

  // Entity suffixes after the comma ("Parkway, LLC") are not given names.
  if (
    /^(llc|l\.l\.c\.|inc\.?|ltd\.?|llp|l\.l\.p\.|pc|p\.c\.|pa|p\.a\.|corp\.?|co\.?)$/i.test(
      givenPart,
    )
  ) {
    return [trimmed];
  }

  const givens = givenPart
    .split(/\s*(?:&|\band\b)\s*/i)
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
  if (givens.length === 0) return [trimmed];

  return givens.map((g) => `${g} ${last}`);
}
