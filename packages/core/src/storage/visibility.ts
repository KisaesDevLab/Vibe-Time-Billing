// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Visibility-rule evaluator (Phase 6 of FILE_MANAGER_ADDENDUM.md
// §3.6 + §4 Phase 6).
//
// The DB column `firm_folder_visibility_rules.subfolder_pattern` is a
// SQL LIKE pattern. The sync worker and the upload path both need to
// pick a default visibility *before* writing a row — for the sync
// worker this happens for every newly indexed file each tick, so we
// evaluate in-memory against a snapshot of the firm's enabled rules
// rather than round-tripping a query per file.
//
// `matchesLikePattern` implements the LIKE semantics we need:
//   %        — zero or more chars
//   _        — exactly one char
//   no other metachars; comparison is case-sensitive (matches Postgres
//   default LIKE behaviour — ILIKE is intentionally not supported here
//   to keep the contract simple).
//
// resolveDefaultVisibility picks the highest-priority enabled rule
// whose pattern matches the subfolder path. Ties broken by insertion
// order (caller's responsibility to sort by priority desc before
// passing in). No match → 'private'.

export type FileVisibility = 'private' | 'client_visible';

export interface VisibilityRule {
  subfolderPattern: string;
  defaultVisibility: FileVisibility;
  priority: number;
  enabled: boolean;
}

/**
 * Compiles a SQL LIKE pattern into a RegExp. Only `%` and `_` are
 * treated as metacharacters; everything else is escaped.
 */
export function likePatternToRegex(pattern: string): RegExp {
  let src = '';
  for (const ch of pattern) {
    if (ch === '%') src += '.*';
    else if (ch === '_') src += '.';
    else if (/[.*+?^${}()|[\]\\]/.test(ch)) src += '\\' + ch;
    else src += ch;
  }
  return new RegExp(`^${src}$`);
}

/** Returns true if `subfolderPath` matches the LIKE `pattern`. */
export function matchesLikePattern(subfolderPath: string, pattern: string): boolean {
  // Drop trailing slash from the path for friendlier matching — the
  // rule patterns (Invoices, Engagement Letters, Client Copy%) don't
  // include the trailing slash, and storing them with it would make
  // the catchall '%' rule match the empty string too aggressively.
  const normalized = subfolderPath.endsWith('/') ? subfolderPath.slice(0, -1) : subfolderPath;
  return likePatternToRegex(pattern).test(normalized);
}

/**
 * Resolves the default visibility for a newly indexed file based on
 * its `subfolder_path` within the client folder. Pure: zero IO.
 *
 * Rules are evaluated in priority desc order; ties broken by input
 * order. First match wins. No match → 'private'.
 */
export function resolveDefaultVisibility(
  subfolderPath: string,
  rules: VisibilityRule[],
): FileVisibility {
  const enabled = rules.filter((r) => r.enabled).slice();
  enabled.sort((a, b) => b.priority - a.priority);
  for (const rule of enabled) {
    if (matchesLikePattern(subfolderPath, rule.subfolderPattern)) {
      return rule.defaultVisibility;
    }
  }
  return 'private';
}

/** Default rule pack seeded for every firm at creation time. */
export const DEFAULT_VISIBILITY_RULES: ReadonlyArray<Omit<VisibilityRule, 'enabled'>> = [
  { subfolderPattern: 'Invoices', defaultVisibility: 'client_visible', priority: 100 },
  { subfolderPattern: 'Engagement Letters', defaultVisibility: 'client_visible', priority: 100 },
  { subfolderPattern: 'Client Copy%', defaultVisibility: 'client_visible', priority: 100 },
  { subfolderPattern: 'Workpapers', defaultVisibility: 'private', priority: 100 },
  { subfolderPattern: 'Internal%', defaultVisibility: 'private', priority: 100 },
  { subfolderPattern: '%', defaultVisibility: 'private', priority: 0 },
];
