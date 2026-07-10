// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Onboarding match scoring for the storage rebuild (Phase 4 of
// FILE_MANAGER_ADDENDUM.md §4 Phase 4).
//
// Given a top-level folder name discovered in B2 and the firm's list
// of clients, returns the best match candidates with a confidence
// score in [0, 1]. The admin UI surfaces the top 3, plus a list of
// clients with no `client_folders` binding.
//
// Two signals feed the score:
//   1. tax_software_id parsed from the folder name (e.g.
//      "0042 - Smith, John" → "0042"). Exact match against
//      `clients.tax_software_id` → confidence 1.0.
//   2. Normalized name similarity. Reorders "Last, First" → "First Last",
//      lowercases, strips punctuation + spouse markers ("& spouse",
//      "& mary", "and family"), then compares against the client's
//      `name`/`clientFacingName`. Similarity = 1 - (levenshtein / maxLen),
//      clamped and rescaled into [0.6, 0.95] when ≥ 0.5.

const SPOUSE_MARKERS = [/& *spouse\b/g, /\band family\b/g, /\band wife\b/g, /\band husband\b/g];

const PUNCTUATION_RE = /[.,;:'"!?(){}[\]\\/_-]+/g;

/** Strip non-name noise. Idempotent. */
export function normalizeName(input: string): string {
  let s = (input ?? '').toLowerCase();
  // Reorder "Last, First" → "First Last" when there's exactly one comma.
  const commaIdx = s.indexOf(',');
  if (commaIdx > 0 && s.indexOf(',', commaIdx + 1) === -1) {
    const last = s.slice(0, commaIdx).trim();
    const first = s.slice(commaIdx + 1).trim();
    if (last && first) s = `${first} ${last}`;
  }
  for (const re of SPOUSE_MARKERS) s = s.replace(re, ' ');
  s = s.replace(/&/g, ' ');
  s = s.replace(PUNCTUATION_RE, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Parses a leading tax-software identifier off a folder name.
 * Recognized shapes:
 *   "0042 - Smith, John"      → "0042"
 *   "0042-Smith, John"        → "0042"
 *   "[A123] Acme LLC"          → "A123"
 *   "Acme LLC"                → null
 * Returns null when no recognizable id prefix is present.
 */
export function parseTaxSoftwareId(folderName: string): string | null {
  const trimmed = folderName.replace(/\/$/, '').trim();
  // Bracketed prefix: [foo] rest
  const bracket = /^\[([A-Za-z0-9_-]{1,32})\]\s+/.exec(trimmed);
  if (bracket) return bracket[1] ?? null;
  // Leading numeric / alphanumeric token followed by " - " or "-" or whitespace.
  const head = /^([A-Za-z0-9][A-Za-z0-9_-]{0,31})\s*(?:[-:]\s*|\s+-\s+)/.exec(trimmed);
  if (!head) return null;
  const candidate = head[1] ?? '';
  // Don't claim ordinary words as ids. Require at least one digit OR
  // a length >= 3 alphanumeric run.
  if (!/\d/.test(candidate) && candidate.length < 3) return null;
  // Also reject obvious words (e.g. "Smith - Acme").
  if (/^[a-zA-Z]+$/.test(candidate) && candidate.length > 4) return null;
  return candidate;
}

/**
 * Standard iterative Levenshtein distance with two-row buffer.
 * O(n*m) time, O(min(n,m)) space. Cheap enough for n,m ≤ ~80.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure b is the shorter row dim for memory.
  if (a.length < b.length) [a, b] = [b, a];
  const prev = new Array(b.length + 1).fill(0) as number[];
  const curr = new Array(b.length + 1).fill(0) as number[];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1, // deletion
        (curr[j - 1] ?? 0) + 1, // insertion
        (prev[j - 1] ?? 0) + cost, // substitution
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/** Symmetric similarity in [0, 1] — 1 means strings match exactly after normalization. */
export function nameSimilarity(folderName: string, clientName: string): number {
  const a = normalizeName(folderName);
  const b = normalizeName(clientName);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  const longest = Math.max(a.length, b.length);
  return Math.max(0, 1 - dist / longest);
}

export interface ClientForMatching {
  id: string;
  name: string;
  clientFacingName?: string | null;
  taxSoftwareId?: string | null;
}

export interface MatchCandidate {
  clientId: string;
  confidence: number; // [0, 1]
  reason: 'tax_software_id' | 'normalized_name';
}

/**
 * Given a folder name + the firm's clients, returns up to `topN`
 * candidates ordered by confidence desc.
 *
 * Scoring:
 *   - Exact tax_software_id match → 1.0 (reason: 'tax_software_id').
 *   - Normalized name similarity ≥ 0.5 → rescaled into [0.6, 0.95]
 *     (reason: 'normalized_name'). Below 0.5 → dropped.
 *
 * Tax-software hits and name hits are deduped per client — only the
 * higher-confidence reason survives.
 */
export function scoreFolderMatches(
  folderName: string,
  clients: ClientForMatching[],
  opts: { topN?: number; nameFloor?: number } = {},
): MatchCandidate[] {
  const topN = opts.topN ?? 3;
  const nameFloor = opts.nameFloor ?? 0.5;

  const byClient = new Map<string, MatchCandidate>();

  const folderTaxId = parseTaxSoftwareId(folderName);
  if (folderTaxId) {
    for (const c of clients) {
      if (c.taxSoftwareId && c.taxSoftwareId === folderTaxId) {
        byClient.set(c.id, {
          clientId: c.id,
          confidence: 1,
          reason: 'tax_software_id',
        });
      }
    }
  }

  for (const c of clients) {
    if (byClient.has(c.id)) continue;
    const candidates = [c.name];
    if (c.clientFacingName) candidates.push(c.clientFacingName);
    let best = 0;
    for (const candidate of candidates) {
      const s = nameSimilarity(folderName, candidate);
      if (s > best) best = s;
    }
    if (best < nameFloor) continue;
    // Map [nameFloor, 1.0) → [0.6, 0.95]. Exact 1.0 stays 0.95 here
    // because we reserve 1.0 for tax_software_id matches.
    const span = 1 - nameFloor;
    const normalized = span > 0 ? (best - nameFloor) / span : 0;
    const confidence = 0.6 + normalized * 0.35;
    byClient.set(c.id, {
      clientId: c.id,
      confidence: Math.min(0.95, confidence),
      reason: 'normalized_name',
    });
  }

  return Array.from(byClient.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, topN);
}
