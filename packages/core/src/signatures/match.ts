// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Bookmark → signature-page matching. Given the parsed outline sections of a
// tax-return PDF and the firm's ordered page rules, find every page whose
// bookmark title matches an enabled rule applicable to the return type. The
// federal 8879 and any present state e-file authorizations are all surfaced;
// pages are de-duplicated (first matching rule wins per page).

import type { FlatSection } from '../tax-returns/outline-walker';
import { ruleAppliesToReturn } from './return-types';

export type PageRuleMatchMode = 'contains' | 'exact' | 'regex';

/** The subset of a signature_page_rules row needed to match. */
export interface SignaturePageRule {
  id: string;
  formType: string;
  bookmarkPattern: string;
  matchMode: PageRuleMatchMode;
  caseSensitive: boolean;
  layoutKey: string;
  /** 0145 — when set, the firm's latest placement profile for this form
   *  type supplies the fields instead of layoutKey's built-in layout. */
  profileFormType?: string | null;
  enabled: boolean;
  sortOrder?: number;
}

export interface MatchedSignaturePage {
  pageNumber: number;
  bookmarkTitle: string;
  ruleId: string;
  layoutKey: string;
  profileFormType?: string | null;
}

function titleMatches(rule: SignaturePageRule, title: string): boolean {
  const hay = rule.caseSensitive ? title : title.toLowerCase();
  const needle = rule.caseSensitive ? rule.bookmarkPattern : rule.bookmarkPattern.toLowerCase();
  if (!needle) return false;
  switch (rule.matchMode) {
    case 'exact':
      return hay.trim() === needle.trim();
    case 'regex':
      try {
        return new RegExp(rule.bookmarkPattern, rule.caseSensitive ? '' : 'i').test(title);
      } catch {
        return false; // invalid pattern never matches
      }
    case 'contains':
    default:
      return hay.includes(needle);
  }
}

/**
 * Find signature pages in a return's outline. Sections are matched against the
 * enabled rules (ordered by sortOrder) whose form_type applies to the return;
 * a section matches if its rawTitle OR normalizedTitle hits the rule. One page
 * is emitted at most once (first matching rule wins). Pure + deterministic.
 */
export function matchSignaturePages(
  sections: FlatSection[],
  rules: SignaturePageRule[],
  returnFormCode: string | null,
): MatchedSignaturePage[] {
  const applicable = rules
    .filter((r) => r.enabled && ruleAppliesToReturn(r.formType, returnFormCode))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const byPage = new Map<number, MatchedSignaturePage>();
  for (const section of sections) {
    if (byPage.has(section.startPage)) continue;
    for (const rule of applicable) {
      if (titleMatches(rule, section.rawTitle) || titleMatches(rule, section.normalizedTitle)) {
        byPage.set(section.startPage, {
          pageNumber: section.startPage,
          bookmarkTitle: section.rawTitle || section.normalizedTitle,
          ruleId: rule.id,
          layoutKey: rule.layoutKey,
          profileFormType: rule.profileFormType ?? null,
        });
        break;
      }
    }
  }
  return [...byPage.values()].sort((a, b) => a.pageNumber - b.pageNumber);
}
