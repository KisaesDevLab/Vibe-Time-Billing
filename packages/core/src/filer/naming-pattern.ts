// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0223 — firm file-naming convention. The AI returns structured fields
// (document type, issuer, year, period, date, confidence); the app fills
// the firm's pattern deterministically, so the convention is enforced
// and the model never emits a filename. Pure: no I/O, unit-tested.

export const NAMING_SLOTS = [
  'year',
  'period',
  'doc_type',
  'issuer',
  'client',
  'client_id',
  'original',
  'date',
] as const;
export type NamingSlot = (typeof NAMING_SLOTS)[number];

export interface NamingFields {
  doc_type?: string | null;
  issuer?: string | null;
  /** "2024" */
  year?: string | null;
  /** "Q3", "Jan", "2024-03", "FY2023" */
  period?: string | null;
  /** Client display name (always present). */
  client: string;
  /** Firm's client number / code, if any. */
  client_id?: string | null;
  /** Original filename stem (no extension). */
  original: string;
  /** YYYY-MM-DD */
  date?: string | null;
}

export const DEFAULT_NAMING_PATTERN = '{year} {doc_type} - {issuer} - {client}';
export const DEFAULT_NAMING_EXAMPLES = [
  '2024 W-2 - Acme Corp - Smith John',
  '2023 Form 1040 - Smith John',
  '2024-Q3 Bank Statement - Chase - Smith Family Trust',
].join('\n');

export const MAX_PATTERN_LENGTH = 120;
export const DEFAULT_MAX_STEM_LENGTH = 120;

const SLOT_RE = /\{([a-z_]+)\}/g;

export function validatePattern(pattern: string): { ok: true } | { ok: false; error: string } {
  const p = pattern.trim();
  if (!p) return { ok: false, error: 'pattern_empty' };
  if (p.length > MAX_PATTERN_LENGTH) return { ok: false, error: 'pattern_too_long' };
  const slots = [...p.matchAll(SLOT_RE)].map((m) => m[1]!);
  if (slots.length === 0) return { ok: false, error: 'pattern_has_no_slots' };
  const unknown = slots.find((s) => !(NAMING_SLOTS as readonly string[]).includes(s));
  if (unknown) return { ok: false, error: `unknown_slot:${unknown}` };
  if (/[\\/:*?"<>|]/.test(p.replace(SLOT_RE, ''))) {
    return { ok: false, error: 'pattern_has_illegal_characters' };
  }
  return { ok: true };
}

function clean(v: string | null | undefined): string {
  return (v ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fill the pattern and tidy the result:
 *   - empty slots vanish, and separator runs left behind (" - ", "–", "_",
 *     ".", " ") collapse to a single " - " / " "
 *   - leading/trailing separators are stripped
 *   - empty result → original stem
 *   - truncated at a word boundary to `maxStemLength`
 * Returns the stem only (no extension).
 */
export function fillPattern(
  pattern: string,
  fields: NamingFields,
  opts: { maxStemLength?: number } = {},
): string {
  const max = opts.maxStemLength ?? DEFAULT_MAX_STEM_LENGTH;
  const values: Record<NamingSlot, string> = {
    year: clean(fields.year),
    period: clean(fields.period),
    doc_type: clean(fields.doc_type),
    issuer: clean(fields.issuer),
    client: clean(fields.client),
    client_id: clean(fields.client_id),
    original: clean(fields.original),
    date: clean(fields.date),
  };
  // Tokenise: literal text vs slot. Empty slots drop the separator that
  // immediately precedes them (so "{year} {doc_type} - {issuer} - {client}"
  // with a null issuer → "2024 W-2 - Smith John").
  let out = '';
  let lastIndex = 0;
  let pendingSep = '';
  for (const m of pattern.matchAll(SLOT_RE)) {
    const literal = pattern.slice(lastIndex, m.index);
    lastIndex = (m.index ?? 0) + m[0].length;
    const slot = m[1] as NamingSlot;
    const value = (NAMING_SLOTS as readonly string[]).includes(slot) ? values[slot] : '';
    pendingSep += literal;
    if (value) {
      out += (out ? pendingSep : pendingSep.replace(/^[\s\-–_.,]+/, '')) + value;
      pendingSep = '';
    }
  }
  const tail = pattern.slice(lastIndex);
  if (out && /[^\s\-–_.,]/.test(tail)) out += pendingSep + tail;

  let stem = out
    .replace(/\s+/g, ' ')
    .replace(/(\s*[-–_.,]\s*){2,}/g, ' - ')
    .replace(/^[\s\-–_.,]+|[\s\-–_.,]+$/g, '')
    .trim();
  if (!stem) stem = values.original || 'document';
  if (stem.length > max) {
    const cut = stem.slice(0, max);
    const at = cut.lastIndexOf(' ');
    stem = (at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s\-–_.,]+$/, '');
  }
  return stem;
}

/** Stem from the pattern + the ORIGINAL file's extension (lower-cased). */
export function composeFilename(
  pattern: string,
  fields: NamingFields,
  originalFilename: string,
  opts: { maxStemLength?: number } = {},
): string {
  const dot = originalFilename.lastIndexOf('.');
  const ext =
    dot > 0 && dot < originalFilename.length - 1 ? originalFilename.slice(dot).toLowerCase() : '';
  const stemOfOriginal = dot > 0 ? originalFilename.slice(0, dot) : originalFilename;
  const stem = fillPattern(
    pattern,
    { ...fields, original: fields.original || stemOfOriginal },
    opts,
  );
  return `${stem}${ext}`;
}

/** Sample fields for a live preview in settings. */
export const SAMPLE_NAMING_FIELDS: NamingFields = {
  year: '2024',
  period: 'Q3',
  doc_type: 'W-2',
  issuer: 'Acme Corp',
  client: 'Smith John',
  client_id: 'SMITH01',
  original: 'scan0023',
  date: '2025-01-31',
};
