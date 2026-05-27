// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-1 §3.1 — Normalization lexicon for tax-return PDF bookmarks.
//
// Each pattern matches a verbatim bookmark title and yields a
// `(form_code, kind, normalized_title)` tuple. Patterns are tried in
// order and the FIRST match wins (so put specific cases above generic
// ones).
//
// `recipient_capture` (optional) is the regex group index whose value
// becomes the `recipient_name` on the section (used for K-1 partners
// + shareholders). `default_releasable=false` (optional) tells the
// caller to set `releasable=false` at parse time — preparer
// worksheets default to internal-only.
//
// The plan calls for a YAML file at apps/web/server/tax/lexicon.yaml.
// We ship the lexicon as a plain TS array instead — easier to type-
// check, easier to test, and YAML loading needs a runtime dep we
// don't have. The shape is identical; converting to YAML later is
// trivial.

export type TaxSectionKind =
  | 'COVER'
  | 'MAIN_FORM'
  | 'SCHEDULE'
  | 'K1'
  | 'STATE'
  | 'WORKSHEET'
  | 'ATTACHMENT'
  | 'UNKNOWN';

export interface LexiconPattern {
  re: RegExp;
  // Form-code template. `{1}` etc. interpolate regex capture groups.
  formCode: string | null;
  kind: TaxSectionKind;
  // Normalized-title template with same {N} substitution. Falls back
  // to the regex match[0] when not set.
  normalized: string;
  recipientCapture?: number;
  defaultReleasable?: boolean;
}

// Substitute `{1}`, `{2}` etc. with regex match groups. `{0}` is the
// full match.
function interpolate(template: string, match: RegExpMatchArray): string {
  return template.replace(/\{(\d+)\}/g, (_, n) => {
    const idx = Number(n);
    return match[idx] ?? '';
  });
}

export const DEFAULT_LEXICON: LexiconPattern[] = [
  // K-1s — recipient capture must come BEFORE the generic Schedule
  // pattern since "Schedule K-1 — ..." would otherwise match
  // `Schedule [A-Z]`. Cover the common variants emitted by UltraTax,
  // Lacerte, ProSeries, and Drake:
  //   "Schedule K-1 — Name"
  //   "Schedule K-1 (Form 1065) — Name"
  //   "K-1 — Name" / "K-1: Name" / "K-1 for Name"
  //   "Partner K-1: Name" / "Shareholder K-1: Name"
  //   "Schedule K-1" (no recipient, no parens) — last so it doesn't
  //   swallow the captured variants above.
  {
    re: /^Schedule K-1\s*\(Form\s+\d{3,5}[A-Z-]*\)\s*[—\-:]\s*(.+?)\s*$/i,
    formCode: 'K-1',
    kind: 'K1',
    normalized: 'Schedule K-1 — {1}',
    recipientCapture: 1,
  },
  {
    re: /^Schedule K-1\b.*?[—\-:]\s*(.+?)\s*$/i,
    formCode: 'K-1',
    kind: 'K1',
    normalized: 'Schedule K-1 — {1}',
    recipientCapture: 1,
  },
  {
    re: /^(?:Partner|Shareholder|Beneficiary)\s+K-1\s*[—\-:]\s*(.+?)\s*$/i,
    formCode: 'K-1',
    kind: 'K1',
    normalized: 'Schedule K-1 — {1}',
    recipientCapture: 1,
  },
  {
    re: /^K-1\s+for\s+(.+?)\s*$/i,
    formCode: 'K-1',
    kind: 'K1',
    normalized: 'Schedule K-1 — {1}',
    recipientCapture: 1,
  },
  {
    re: /^K-1\s*[—\-:]\s*(.+?)\s*$/i,
    formCode: 'K-1',
    kind: 'K1',
    normalized: 'Schedule K-1 — {1}',
    recipientCapture: 1,
  },
  {
    re: /^Schedule K-1\b/i,
    formCode: 'K-1',
    kind: 'K1',
    normalized: 'Schedule K-1',
  },
  // 1040 family — 1040-X must precede plain 1040 to avoid greedy match.
  {
    re: /^Form 1040-X\b/i,
    formCode: '1040-X',
    kind: 'MAIN_FORM',
    normalized: 'Form 1040-X',
  },
  {
    re: /^Form 1040(-SR)?\b/i,
    formCode: '1040',
    kind: 'MAIN_FORM',
    normalized: 'Form 1040',
  },
  // 1120/1120-S/1065/1041/990
  {
    re: /^Form 1120-?S\b/i,
    formCode: '1120-S',
    kind: 'MAIN_FORM',
    normalized: 'Form 1120-S',
  },
  {
    re: /^Form 1120\b/i,
    formCode: '1120',
    kind: 'MAIN_FORM',
    normalized: 'Form 1120',
  },
  {
    re: /^Form 1065\b/i,
    formCode: '1065',
    kind: 'MAIN_FORM',
    normalized: 'Form 1065',
  },
  {
    re: /^Form 1041\b/i,
    formCode: '1041',
    kind: 'MAIN_FORM',
    normalized: 'Form 1041',
  },
  {
    re: /^Form 990\b/i,
    formCode: '990',
    kind: 'MAIN_FORM',
    normalized: 'Form 990',
  },
  // 706 (estate)
  {
    re: /^Form 706\b/i,
    formCode: '706',
    kind: 'MAIN_FORM',
    normalized: 'Form 706',
  },
  // Generic schedule (A, B, C, D, E, L, M-1, M-2 …) — letter or digit
  {
    re: /^Schedule\s+([A-Z](?:-\d)?|\d{1,2})\b/i,
    formCode: 'Schedule {1}',
    kind: 'SCHEDULE',
    normalized: 'Schedule {1}',
  },
  // Generic numbered form (8949, 8606, etc.)
  {
    re: /^Form\s+(\d{3,5}[A-Z-]*)\b/i,
    formCode: 'Form {1}',
    kind: 'SCHEDULE',
    normalized: 'Form {1}',
  },
  // State return
  {
    re: /^State[\s—-]+(.+?)\s*$/i,
    formCode: 'State',
    kind: 'STATE',
    normalized: 'State — {1}',
  },
  // Cover sheet
  {
    re: /^(Cover|Cover Sheet|Filing Instructions|Letter)$/i,
    formCode: null,
    kind: 'COVER',
    normalized: 'Cover',
  },
  // Worksheets (default not releasable)
  {
    re: /^Worksheets?\b/i,
    formCode: null,
    kind: 'WORKSHEET',
    normalized: 'Worksheets',
    defaultReleasable: false,
  },
  // Federal header (just a grouping label; usually has children)
  {
    re: /^Federal$/i,
    formCode: null,
    kind: 'COVER',
    normalized: 'Federal',
  },
];

export interface NormalizationResult {
  formCode: string | null;
  kind: TaxSectionKind;
  normalizedTitle: string;
  recipientName: string | null;
  parseConfidence: number;
  defaultReleasable: boolean;
}

/**
 * Apply the lexicon to a raw bookmark title. Returns the first match,
 * or an `UNKNOWN` result when nothing matches. `parseConfidence` is
 * 100 for outline matches; the caller drops it to 60 for header-
 * detection fallback matches.
 */
export function normalizeTitle(
  rawTitle: string,
  lexicon: LexiconPattern[] = DEFAULT_LEXICON,
): NormalizationResult {
  const trimmed = rawTitle.trim();
  for (const p of lexicon) {
    const m = trimmed.match(p.re);
    if (!m) continue;
    const normalizedTitle = interpolate(p.normalized, m);
    const formCode = p.formCode == null ? null : interpolate(p.formCode, m);
    const recipientName =
      p.recipientCapture != null ? (m[p.recipientCapture]?.trim() ?? null) : null;
    return {
      formCode,
      kind: p.kind,
      normalizedTitle,
      recipientName,
      parseConfidence: 100,
      defaultReleasable: p.defaultReleasable ?? true,
    };
  }
  return {
    formCode: null,
    kind: 'UNKNOWN',
    normalizedTitle: trimmed,
    recipientName: null,
    parseConfidence: 0,
    defaultReleasable: true,
  };
}
