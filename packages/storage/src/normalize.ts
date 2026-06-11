// SPDX-License-Identifier: Elastic-2.0
//
// FMv2 §3.4 — Folder/client name normalization rules.
//
// Spec order:
//   1. Strip trailing slash and `_Vibe/` references.
//   2. Strip leading tax-ID prefix.
//   3. Strip spouse markers at end (case-insensitive against the raw
//      input; runs BEFORE lowercase + punctuation removal so the
//      `&` and capitalization survive long enough to be detected).
//   4. Lowercase.
//   5. Remove punctuation.
//   6. Split on whitespace, drop tokens < 2 chars, drop business
//      suffixes.
//
// IMPORTANT: spec example "Smith, John & Mary" → ['smith', 'john']
// preserves input order. We do NOT reorder Last, First. The match
// engine accounts for cross-order matches via `name_swap_match`.

const SPOUSE_AT_END = /\s+(?:and|&|plus)\s+(?:spouse|family|wife|husband|[\w-]+)\s*$/i;
const PUNCTUATION_RE = /[.,;:'"!?(){}[\]\\/_-]+/g;

const BUSINESS_SUFFIXES = new Set([
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited',
  'pllc',
  'pa',
  'ps',
  'pc',
  'lp',
  'llp',
  'lllp',
  'the',
]);

export const LOW_SIGNAL_TOKENS = new Set([
  'family',
  'personal',
  'taxes',
  'tax',
  'clients',
  'client',
  'documents',
  'docs',
  'files',
]);

export function extractTaxId(folderName: string): string | null {
  const trimmed = folderName.replace(/\/$/, '').trim();
  const bracket = /^\[([A-Za-z0-9_-]{1,32})\]\s*/.exec(trimmed);
  if (bracket) return bracket[1] ?? null;
  const head = /^([A-Za-z0-9][A-Za-z0-9_-]{0,31})\s*(?:[-:]\s*|\s+-\s+)/.exec(trimmed);
  if (!head) return null;
  const candidate = head[1] ?? '';
  if (!/\d/.test(candidate) && candidate.length < 3) return null;
  if (/^[a-zA-Z]+$/.test(candidate) && candidate.length > 4) return null;
  return candidate;
}

export function stripTaxIdPrefix(folderName: string): string {
  const trimmed = folderName.replace(/\/$/, '').trim();
  const bracket = /^\[[A-Za-z0-9_-]{1,32}\]\s*/.exec(trimmed);
  if (bracket) return trimmed.slice(bracket[0].length).trim();
  const head = /^([A-Za-z0-9][A-Za-z0-9_-]{0,31})\s*(?:[-:]\s*|\s+-\s+)/.exec(trimmed);
  if (head) {
    const candidate = head[1] ?? '';
    if (
      (/\d/.test(candidate) || candidate.length >= 3) &&
      !(/^[a-zA-Z]+$/.test(candidate) && candidate.length > 4)
    ) {
      return trimmed.slice(head[0].length).trim();
    }
  }
  return trimmed;
}

// Strip trailing spouse / partnership / business co-tag at end of
// the human-readable name. Runs on raw (case-preserved) input; the
// regex is /i so it doesn't care about case. Repeats up to 3 times
// to peel nested forms like "Smith and Mary and family".
export function stripSpouseMarkers(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(SPOUSE_AT_END, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

export function normalizeName(rawName: string): string[] {
  let s = rawName ?? '';
  // 1. Strip trailing slash + _Vibe/.
  s = s.replace(/\/$/, '');
  s = s.replace(/\/?_Vibe\/?(?:client\.json)?$/i, '');
  s = s.trim();
  // 2. Strip tax-id prefix.
  s = stripTaxIdPrefix(s);
  // 3. Strip spouse markers BEFORE lowercase + punctuation so `&` is
  //    still recognizable.
  s = stripSpouseMarkers(s);
  // 4. Lowercase.
  s = s.toLowerCase();
  // 5. Remove punctuation; `&` → space.
  s = s.replace(PUNCTUATION_RE, ' ');
  s = s.replace(/&/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // 6. Tokenize; drop short tokens + business suffixes.
  return s.split(' ').filter((t) => t.length >= 2 && !BUSINESS_SUFFIXES.has(t));
}

export function normalizeNameString(rawName: string): string {
  return normalizeName(rawName).join(' ');
}

export function significantTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !LOW_SIGNAL_TOKENS.has(t));
}
