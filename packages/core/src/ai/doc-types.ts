// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Controlled vocabulary + PII guard for AI document naming. One shared
// list keeps the prompt, the validators, and any UI filter in lockstep —
// the model cannot invent document types, and no model-produced field
// can carry an SSN/EIN/account number into a filename.

/** Controlled doc_type vocabulary (v1). The prompt injects this verbatim. */
export const DOC_TYPES = [
  'W-2',
  'W-2G',
  '1099-NEC',
  '1099-MISC',
  '1099-INT',
  '1099-DIV',
  '1099-B',
  '1099-R',
  '1099-G',
  '1099-K',
  '1099-S',
  '1098',
  '1098-T',
  '1098-E',
  '1095-A',
  '1095-B',
  '1095-C',
  'K-1-1065',
  'K-1-1120S',
  'K-1-1041',
  'SSA-1099',
  'Bank-Statement',
  'Brokerage-Statement',
  'Credit-Card-Statement',
  'Payroll-Report',
  'Sales-Tax-Report',
  'Property-Tax-Bill',
  'Closing-Statement',
  'IRS-Notice',
  'State-Notice',
  'Prior-Year-Return',
  'Organizer',
  'Engagement-Letter',
  'ID-Document',
  'Receipt',
  'Invoice',
  'Handwritten-Note',
  // Review additions — common accounting-firm documents the v1 list missed.
  'W-9',
  'Form-1040',
  'Form-1120',
  'Form-1120S',
  'Form-1065',
  'Form-941',
  'Form-940',
  'Financial-Statement',
  'Profit-and-Loss',
  'Balance-Sheet',
  'Mortgage-Statement',
  'Voided-Check',
  'Trust-Document',
  'Other',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

const DOC_TYPE_SET = new Set<string>(DOC_TYPES);

/**
 * Map a model-emitted doc_type onto the vocabulary: exact match wins,
 * then a case/punctuation-insensitive match; anything else → 'Other'.
 */
export function normalizeDocType(raw: string | null | undefined): DocType | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (DOC_TYPE_SET.has(trimmed)) return trimmed as DocType;
  const canon = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = canon(trimmed);
  for (const t of DOC_TYPES) {
    if (canon(t) === target) return t;
  }
  return 'Other';
}

/**
 * The doc_type value usable in a FILENAME: the literal catch-all 'Other'
 * carries no information and would rename real documents to
 * "2024 Other - …" — it stays in the stored label but never in a name.
 */
export function filenameDocType(dt: DocType | null): DocType | null {
  return dt === 'Other' ? null : dt;
}

/**
 * PII patterns that must never reach a filename. Order matters only for
 * readability; every pattern is tested against every field.
 */
export const PII_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'ssn', re: /\b\d{3}-?\d{2}-?\d{4}\b/ },
  { name: 'ein', re: /\b\d{2}-\d{7}\b/ },
  { name: 'account', re: /\b\d{8,17}\b/ },
];

/**
 * Drop (null out) any string field containing a PII-like pattern — the
 * field is lost, the file is kept, the pattern engine collapses the
 * empty slot. Non-string values pass through untouched.
 */
export function stripPiiFields<T extends Record<string, unknown>>(fields: T): T {
  const out: Record<string, unknown> = { ...fields };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string') continue;
    if (PII_PATTERNS.some((p) => p.re.test(value))) out[key] = null;
  }
  return out as T;
}
