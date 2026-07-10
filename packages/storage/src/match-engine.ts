// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// FMv2 §3 — Match engine.
//
// Given one client and a list of folder candidates, returns the
// candidates ranked by confidence with a reason code each. Used by:
//   • POST /api/clients/:id/folder/match (the link modal)
//   • Bulk onboarding flow (v1 Phase 4) — refactored to iterate
//     match() over every client and aggregate (in §3.1 the bulk
//     tool no longer scores per-folder independently).
//
// All scoring is pure. Performance budget (§3.6): O(folders) work,
// ≤ 0.1ms per folder → total < 1s for 5k folders.

import { jaroWinkler } from './jaro-winkler';
import { LOW_SIGNAL_TOKENS, extractTaxId, normalizeName, significantTokens } from './normalize';

export type MatchReasonCode =
  | 'tax_id_in_folder_name'
  | 'exact_name_match'
  | 'name_swap_match'
  | 'name_substring_match'
  | 'alias_match'
  | 'fuzzy_name_match'
  | 'partial_token_match';

export type MatchStatus = 'unbound' | 'bound_to_self' | 'bound_to_other';

export interface ClientForMatch {
  id: string;
  name: string;
  /** From clients.tax_software_id — used by reason `tax_id_in_folder_name`. */
  tax_software_id?: string | null;
  /** Friendlier name displayed to staff (e.g. dba). */
  client_facing_name?: string | null;
  /** Manually-entered alternate names. Matched verbatim post-normalize. */
  aliases?: string[];
}

export interface FolderCandidate {
  storage_path: string;
  file_count: number;
  size_bytes: number;
  last_modified: string;
  sentinel?: {
    client_id: string;
    display_name_at_creation: string;
  };
  bound_to?: {
    client_id: string;
    client_name: string;
  };
}

export interface MatchCandidate {
  storage_path: string;
  confidence: number;
  reason_code: MatchReasonCode | null;
  reason_text: string;
  status: MatchStatus;
  bound_to?: { client_id: string; client_name: string };
  file_count: number;
  size_bytes: number;
  last_modified: string;
}

export interface MatchInput {
  client: ClientForMatch;
  folders: FolderCandidate[];
  options?: {
    min_confidence?: number;
    max_results?: number;
  };
}

export interface MatchOutput {
  candidates: MatchCandidate[];
  unbound_count: number;
  suggested_queries: string[];
}

// Reason → (floor, ceiling). For fixed-confidence reasons floor === ceiling.
const REASON_CONFIDENCE: Record<MatchReasonCode, { floor: number; ceiling: number }> = {
  tax_id_in_folder_name: { floor: 1.0, ceiling: 1.0 },
  exact_name_match: { floor: 0.95, ceiling: 0.95 },
  alias_match: { floor: 0.95, ceiling: 0.95 },
  name_swap_match: { floor: 0.9, ceiling: 0.9 },
  name_substring_match: { floor: 0.85, ceiling: 0.85 },
  fuzzy_name_match: { floor: 0.65, ceiling: 0.84 },
  partial_token_match: { floor: 0.5, ceiling: 0.64 },
};

function tokensEqualUnordered(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

function reasonText(
  code: MatchReasonCode,
  ctx: { tax_id?: string | null; alias?: string; missing?: string[]; tax_software_kind?: string },
): string {
  switch (code) {
    case 'tax_id_in_folder_name':
      return `${ctx.tax_software_kind ?? 'Tax software'} ID ${ctx.tax_id ?? ''} found in folder name`.trim();
    case 'exact_name_match':
      return 'Exact name match';
    case 'name_swap_match':
      return 'Name match — Last/First order swapped';
    case 'name_substring_match':
      if (ctx.missing && ctx.missing.length > 0) {
        return `Name match — missing "${ctx.missing.join(' ')}"`;
      }
      return 'Name match';
    case 'alias_match':
      return ctx.alias ? `Matches known alias "${ctx.alias}"` : 'Matches known alias';
    case 'fuzzy_name_match':
      return 'Approximate name match';
    case 'partial_token_match':
      return 'Some name parts match';
  }
}

function clientCandidateNames(client: ClientForMatch): string[] {
  const out = [client.name];
  if (client.client_facing_name) out.push(client.client_facing_name);
  return out;
}

// Score one folder against one client. Returns the strongest
// reason. Returns null when no signal crosses the partial-match
// floor.
export function scoreFolder(
  folder: FolderCandidate,
  client: ClientForMatch,
): { code: MatchReasonCode; confidence: number; text: string } | null {
  const folderTaxId = extractTaxId(folder.storage_path);
  // Highest signal: tax-software-ID match.
  if (folderTaxId && client.tax_software_id && folderTaxId === client.tax_software_id) {
    return {
      code: 'tax_id_in_folder_name',
      confidence: REASON_CONFIDENCE.tax_id_in_folder_name.floor,
      text: reasonText('tax_id_in_folder_name', { tax_id: folderTaxId }),
    };
  }

  const folderTokens = normalizeName(folder.storage_path);
  if (folderTokens.length === 0) return null;
  const folderString = folderTokens.join(' ');

  // Try every client candidate name (primary + dba) + aliases.
  let best: { code: MatchReasonCode; confidence: number; text: string } | null = null;
  const candidates: { source: string; tokens: string[]; isAlias: boolean }[] = [];
  for (const name of clientCandidateNames(client)) {
    candidates.push({ source: name, tokens: normalizeName(name), isAlias: false });
  }
  for (const alias of client.aliases ?? []) {
    candidates.push({ source: alias, tokens: normalizeName(alias), isAlias: true });
  }

  for (const candidate of candidates) {
    if (candidate.tokens.length === 0) continue;
    const candidateString = candidate.tokens.join(' ');

    // exact_name_match
    if (candidateString === folderString) {
      const code: MatchReasonCode = candidate.isAlias ? 'alias_match' : 'exact_name_match';
      const conf = REASON_CONFIDENCE[code].floor;
      const candidateBest = {
        code,
        confidence: conf,
        text: reasonText(code, { alias: candidate.isAlias ? candidate.source : undefined }),
      };
      if (!best || candidateBest.confidence > best.confidence) best = candidateBest;
      continue;
    }

    // name_swap_match: same tokens, different order
    if (tokensEqualUnordered(folderTokens, candidate.tokens)) {
      const candidateBest = {
        code: 'name_swap_match' as MatchReasonCode,
        confidence: REASON_CONFIDENCE.name_swap_match.floor,
        text: reasonText('name_swap_match', {}),
      };
      if (!best || candidateBest.confidence > best.confidence) best = candidateBest;
      continue;
    }

    // name_substring_match: every significant token of the client
    // name appears in the folder tokens. We report the missing
    // tokens in the reason text. Demote when only low-signal tokens
    // overlap.
    const clientSig = significantTokens(candidate.tokens);
    const folderSet = new Set(folderTokens);
    const missing: string[] = [];
    const matched: string[] = [];
    for (const t of clientSig) {
      if (folderSet.has(t)) matched.push(t);
      else missing.push(t);
    }
    if (
      clientSig.length > 0 &&
      matched.length === clientSig.length &&
      // Folder also has to have at least one significant matched token
      matched.some((t) => !LOW_SIGNAL_TOKENS.has(t))
    ) {
      // Check the folder side: any token of the FOLDER that the
      // client name lacks?
      const folderSig = significantTokens(folderTokens);
      const folderMissing: string[] = [];
      const candidateSet = new Set(candidate.tokens);
      for (const t of folderSig) {
        if (!candidateSet.has(t)) folderMissing.push(t);
      }
      const candidateBest = {
        code: 'name_substring_match' as MatchReasonCode,
        confidence: REASON_CONFIDENCE.name_substring_match.floor,
        text: reasonText('name_substring_match', { missing: folderMissing }),
      };
      if (!best || candidateBest.confidence > best.confidence) best = candidateBest;
      continue;
    }

    // fuzzy_name_match: Jaro-Winkler ≥ 0.85
    const jw = jaroWinkler(folderString, candidateString);
    if (jw >= 0.85) {
      const r = REASON_CONFIDENCE.fuzzy_name_match;
      // Scale jw ∈ [0.85, 1.0] → r.floor..r.ceiling.
      const t = (jw - 0.85) / 0.15;
      const conf = r.floor + t * (r.ceiling - r.floor);
      const candidateBest = {
        code: 'fuzzy_name_match' as MatchReasonCode,
        confidence: conf,
        text: reasonText('fuzzy_name_match', {}),
      };
      if (!best || candidateBest.confidence > best.confidence) best = candidateBest;
      continue;
    }

    // partial_token_match: at least one significant shared token.
    const candidateSet = new Set(candidate.tokens);
    let sharedSig = 0;
    for (const t of folderTokens) {
      if (t.length >= 3 && !LOW_SIGNAL_TOKENS.has(t) && candidateSet.has(t)) sharedSig += 1;
    }
    if (sharedSig > 0) {
      const r = REASON_CONFIDENCE.partial_token_match;
      const denom = Math.max(folderTokens.length, candidate.tokens.length);
      const ratio = sharedSig / denom;
      const conf = r.floor + ratio * (r.ceiling - r.floor);
      const candidateBest = {
        code: 'partial_token_match' as MatchReasonCode,
        confidence: conf,
        text: reasonText('partial_token_match', {}),
      };
      if (!best || candidateBest.confidence > best.confidence) best = candidateBest;
    }
  }

  return best;
}

export function suggestedQueries(client: ClientForMatch): string[] {
  const out: string[] = [];
  if (client.tax_software_id) out.push(client.tax_software_id);
  // Pull last + first name independently.
  const tokens = normalizeName(client.name);
  if (tokens.length >= 1) {
    // The reordered form puts last name at the end after our
    // "Last, First" → "First Last" pass.
    out.push(tokens[tokens.length - 1]!);
    if (tokens.length >= 2) out.push(tokens.slice(0, -1).join(' '));
  }
  // Add the full raw name + each alias.
  if (client.name) out.push(client.name);
  for (const alias of client.aliases ?? []) out.push(alias);
  // Dedupe + drop blanks.
  return Array.from(new Set(out.filter((s) => s.trim().length > 0)));
}

export function match(input: MatchInput): MatchOutput {
  const minConfidence = input.options?.min_confidence ?? 0.5;
  const maxResults = input.options?.max_results ?? 10;
  const out: MatchCandidate[] = [];
  let unboundCount = 0;
  for (const f of input.folders) {
    if (!f.sentinel) unboundCount += 1;
    const status: MatchStatus = !f.sentinel
      ? 'unbound'
      : f.sentinel.client_id === input.client.id
        ? 'bound_to_self'
        : 'bound_to_other';
    const scored = scoreFolder(f, input.client);
    if (!scored) {
      // Even unscored folders can appear if bound_to_self (idempotent
      // re-link). For unbound + bound_to_other with no score, drop.
      if (status === 'bound_to_self') {
        out.push({
          storage_path: f.storage_path,
          confidence: 1.0,
          reason_code: null,
          reason_text: 'Already linked to this client',
          status,
          bound_to: f.bound_to,
          file_count: f.file_count,
          size_bytes: f.size_bytes,
          last_modified: f.last_modified,
        });
      }
      continue;
    }
    if (scored.confidence < minConfidence) continue;
    out.push({
      storage_path: f.storage_path,
      confidence: Math.round(scored.confidence * 1000) / 1000,
      reason_code: scored.code,
      reason_text: scored.text,
      status,
      bound_to: f.bound_to,
      file_count: f.file_count,
      size_bytes: f.size_bytes,
      last_modified: f.last_modified,
    });
  }
  // Sort: unbound first (by confidence desc), then bound_to_self,
  // then bound_to_other (still by confidence desc within each
  // group).
  const statusOrder: Record<MatchStatus, number> = {
    unbound: 0,
    bound_to_self: 1,
    bound_to_other: 2,
  };
  out.sort((a, b) => {
    const so = statusOrder[a.status] - statusOrder[b.status];
    if (so !== 0) return so;
    return b.confidence - a.confidence;
  });
  return {
    candidates: out.slice(0, maxResults),
    unbound_count: unboundCount,
    suggested_queries: suggestedQueries(input.client),
  };
}
