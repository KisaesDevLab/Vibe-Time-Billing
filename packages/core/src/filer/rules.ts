// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Routing-rule evaluation for the Vibe Filer inbox. Ordered list,
// first-enabled-match wins. Pure — the DB/profile plumbing lives in the
// API layer.

export type MatchMode = 'contains' | 'starts_with' | 'regex';
export type YearBehavior = 'none' | 'current_only' | 'current_and_next' | 'previous';

export interface RoutingRule {
  id: string;
  sortOrder: number;
  identifier: string;
  matchMode: MatchMode;
  caseSensitive: boolean;
  targetPath: string;
  yearBehavior: YearBehavior;
  isTaxReturn: boolean;
  enabled: boolean;
}

function ruleMatches(filename: string, rule: RoutingRule): boolean {
  const hay = rule.caseSensitive ? filename : filename.toLowerCase();
  const needle = rule.caseSensitive ? rule.identifier : rule.identifier.toLowerCase();
  if (needle.length === 0) return false;
  switch (rule.matchMode) {
    case 'starts_with':
      return hay.startsWith(needle);
    case 'regex':
      try {
        return new RegExp(rule.identifier, rule.caseSensitive ? '' : 'i').test(filename);
      } catch {
        return false; // invalid regex never matches
      }
    case 'contains':
    default:
      return hay.includes(needle);
  }
}

/** First enabled rule (by sortOrder) whose identifier matches, or null. */
export function evaluateRules(filename: string, rules: RoutingRule[]): RoutingRule | null {
  const ordered = [...rules].filter((r) => r.enabled).sort((a, b) => a.sortOrder - b.sortOrder);
  for (const rule of ordered) {
    if (ruleMatches(filename, rule)) return rule;
  }
  return null;
}

/**
 * The year subfolder a file is filed under for a given behavior. A single
 * file is always filed under one year; `current_and_next` only widens
 * which files a rule *applies to*, not where one file lands. Returns '' for
 * `none`. Returns null when a year is required but none was parsed (the
 * caller surfaces this as `year_needed`).
 */
export function resolveYearSubfolder(
  parsedYear: number | null,
  behavior: YearBehavior,
): string | null {
  if (behavior === 'none') return '';
  if (parsedYear == null) return null; // year required but missing
  const y = behavior === 'previous' ? parsedYear - 1 : parsedYear;
  return `${y}/`;
}
