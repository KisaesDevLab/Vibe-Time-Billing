// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// PII pattern detector for SMS bodies (addendum D8 / Phase 11). Bodies are
// stored raw and never masked; these flags only drive the composer warning
// and Sentinel reporting. Heuristic by design — false positives are cheap
// (a warning), false negatives are not fatal (nothing is redacted).

export type PiiFlag = 'ssn' | 'ein' | 'routing' | 'account' | 'card' | 'dob';

const SSN_RE = /\b(?!000|666|9\d{2})(\d{3})[- ]?(?!00)(\d{2})[- ]?(?!0000)(\d{4})\b/g;
const EIN_RE = /\b\d{2}-\d{7}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const ROUTING_RE = /\b\d{9}\b/g;
const ACCOUNT_RE = /\b(?:acct|account|acc)\.?\s*(?:#|no\.?|number)?\s*:?\s*(\d[\d -]{5,19}\d)\b/gi;
const DOB_RE =
  /\b(?:dob|date of birth|born|birthday|birthdate)\b[^\d]{0,12}(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})/gi;

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** ABA routing number checksum (3-7-1 weights). */
function abaChecksum(d: string): boolean {
  if (d.length !== 9) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i]!;
  return sum % 10 === 0;
}

export function detectPiiPatterns(body: string): PiiFlag[] {
  const flags = new Set<PiiFlag>();
  if (!body) return [];
  const text = body;

  // Card numbers first (Luhn) so a 16-digit card is not also read as SSN+routing.
  const cardSpans: Array<[number, number]> = [];
  for (const m of text.matchAll(CARD_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      flags.add('card');
      cardSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
  }
  const inCard = (idx: number): boolean => cardSpans.some(([a, b]) => idx >= a && idx < b);

  for (const m of text.matchAll(SSN_RE)) {
    if (inCard(m.index ?? 0)) continue;
    // Require separators OR an SSN-ish keyword nearby to avoid flagging any 9-digit run.
    const raw = m[0];
    const hasSep = /[- ]/.test(raw);
    const before = text.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0).toLowerCase();
    if (hasSep || /\bssn\b|social|soc\.?\s*sec/.test(before)) flags.add('ssn');
  }
  for (const m of text.matchAll(EIN_RE)) {
    if (!inCard(m.index ?? 0)) flags.add('ein');
  }
  for (const m of text.matchAll(ROUTING_RE)) {
    if (inCard(m.index ?? 0)) continue;
    const before = text.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0).toLowerCase();
    if (abaChecksum(m[0]) && (/\brouting\b|\baba\b|\brtn\b/.test(before) || !flags.has('ssn'))) {
      if (/\brouting\b|\baba\b|\brtn\b/.test(before) || abaChecksum(m[0])) flags.add('routing');
    }
  }
  if (ACCOUNT_RE.test(text)) flags.add('account');
  ACCOUNT_RE.lastIndex = 0;
  if (DOB_RE.test(text)) flags.add('dob');
  DOB_RE.lastIndex = 0;
  return [...flags];
}
