// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Filename parsing for the Vibe Filer inbox. Best-effort: the export
// owner's convention is `ClientName_NNNNNN_rest.ext` (client names must
// not contain `_`), but parsing degrades gracefully.

export interface ParsedFilename {
  /** Client name segment (before the id), trimmed. */
  name: string | null;
  /** Embedded id (default `\d{4,}`), or null when absent/short. */
  id: string | null;
  /** First in-window 4-digit year found in the remainder, else null. */
  year: number | null;
  /** Everything after the id segment (before the extension). */
  rest: string | null;
  /** File extension without the dot, lowercased. */
  ext: string | null;
  /** True when neither a usable name nor id could be extracted. */
  unparseable: boolean;
}

export interface ParseOptions {
  /** Regex source for the embedded id. Default `\d{4,}`. */
  idPattern?: string;
  /** Injected "now" for the rolling year window (testability). */
  now?: Date;
}

const DEFAULT_ID_PATTERN = '\\d{4,}';

/** Rolling year window: [currentYear - 50, currentYear + 10]. */
export function yearWindow(now: Date = new Date()): { min: number; max: number } {
  const y = now.getUTCFullYear();
  return { min: y - 50, max: y + 10 };
}

function detectYear(rest: string, now: Date): number | null {
  const { min, max } = yearWindow(now);
  // Boundary-guarded: a 4-digit window inside a longer digit run (e.g.
  // "1234" inside id "123456") is not a year candidate.
  const matches = rest.match(/(?<!\d)\d{4}(?!\d)/g);
  if (!matches) return null;
  for (const m of matches) {
    const n = Number(m);
    if (n >= min && n <= max) return n;
  }
  return null;
}

/**
 * Year detection over the WHOLE stem. The strict parser only scans the
 * segment after the `name_ID_` slot, which loses the year when a
 * year-like number was (mis)consumed as the id — e.g.
 * `David, Allen_2025_1040_..._ALLE1234.pdf` parses id="2025", leaving
 * no year in the rest. The loose external-id matcher calls this to
 * recover it.
 */
export function detectYearAnywhere(filename: string, opts: ParseOptions = {}): number | null {
  const now = opts.now ?? new Date();
  const { stem } = splitExt(filename);
  return detectYear(stem, now);
}

export function splitExt(filename: string): { stem: string; ext: string | null } {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return { stem: filename, ext: null };
  return { stem: filename.slice(0, dot), ext: filename.slice(dot + 1).toLowerCase() };
}

/**
 * Parse `ClientName_NNNNNN_rest.ext`.
 *  - Clean parse → name + id + (maybe) year.
 *  - Missing/short id but a name is present → name-only (id null).
 *  - No usable name or id → unparseable.
 */
export function parseFilename(filename: string, opts: ParseOptions = {}): ParsedFilename {
  const now = opts.now ?? new Date();
  const idSrc =
    opts.idPattern && opts.idPattern.trim().length > 0 ? opts.idPattern : DEFAULT_ID_PATTERN;
  const { stem, ext } = splitExt(filename);

  // Strict: name (non-greedy, anchors on the first id boundary) _ id _ rest
  const strict = new RegExp(`^(.+?)_(${idSrc})_(.+)$`);
  const m = strict.exec(stem);
  if (m) {
    const name = m[1]!.trim();
    const id = m[2]!;
    const rest = m[3]!;
    return {
      name: name.length > 0 ? name : null,
      id,
      year: detectYear(rest, now),
      rest,
      ext,
      unparseable: name.length === 0,
    };
  }

  // Name-only fallback: leading segment before the first underscore is the
  // name; the remainder is searched for a year.
  const underscore = stem.indexOf('_');
  if (underscore > 0) {
    const name = stem.slice(0, underscore).trim();
    const rest = stem.slice(underscore + 1);
    if (name.length > 0) {
      return { name, id: null, year: detectYear(rest, now), rest, ext, unparseable: false };
    }
  }

  // A single token with an extension can still be a (weak) name.
  if (stem.trim().length > 0 && ext) {
    return {
      name: stem.trim(),
      id: null,
      year: detectYear(stem, now),
      rest: '',
      ext,
      unparseable: false,
    };
  }

  return { name: null, id: null, year: null, rest: null, ext, unparseable: true };
}

/**
 * Strip the `_{id}_` segment from the original filename, per the routing
 * convention (`Smith_123456_2024.pdf` → `Smith_2024.pdf`). No-op when the
 * id is absent.
 */
export function stripIdSegment(originalName: string, id: string | null): string {
  if (!id) return originalName;
  return originalName.replace(`_${id}_`, '_');
}

/**
 * All id-pattern matches anywhere in the stem (not just the strict
 * `name_ID_rest` slot). Used by the matcher to find a client external
 * id wherever it appears in the filename — "W2 2024 123456.pdf",
 * "Smith-123456 W2.pdf", etc. Year-window numbers are NOT excluded
 * here; the caller matches candidates against real client ids, which
 * disambiguates.
 */
export function extractIdCandidates(filename: string, opts: ParseOptions = {}): string[] {
  const idSrc =
    opts.idPattern && opts.idPattern.trim().length > 0 ? opts.idPattern : DEFAULT_ID_PATTERN;
  const { stem } = splitExt(filename);
  const re = new RegExp(idSrc, 'g');
  const out: string[] = [];
  for (const m of stem.matchAll(re)) {
    if (m[0] && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}
