// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Minimal .xlsx reader for the client-import upload step. Reads the FIRST
// worksheet of an Office Open XML workbook into the same { header, rows }
// shape parseCsv() produces, so the rest of the import pipeline is
// format-agnostic. Deliberately dependency-light: adm-zip (already in the
// monorepo) for the container, hand-rolled XML scanning for the three
// parts we care about (workbook → sheet path, shared strings, sheet
// cells). Good enough for tax-software data-mining exports (UltraTax,
// Lacerte, Drake) — one sheet, flat header row, text/number cells. Not a
// general spreadsheet engine: formulas are read by their cached <v>,
// dates come through as Excel serials (the string of the number), merged
// cells and rich formatting are ignored.

import AdmZip from 'adm-zip';

export class XlsxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxParseError';
  }
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** Concatenate every <t> text run inside a fragment (handles <r><t> rich runs). */
function textRuns(fragment: string): string {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) out += xmlUnescape(m[1] ?? '');
  return out;
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(textRuns(m[1] ?? ''));
  return out;
}

/** "C" → 2, "AA" → 26. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Resolve the first worksheet's zip path. Uses the workbook's <sheets>
 * order + the workbook rels (r:id → Target), falling back to
 * xl/worksheets/sheet1.xml when rels are missing or odd.
 */
function firstSheetPath(zip: AdmZip): string {
  const wb = zip.getEntry('xl/workbook.xml')?.getData().toString('utf8') ?? '';
  const rels = zip.getEntry('xl/_rels/workbook.xml.rels')?.getData().toString('utf8') ?? '';
  const sheet = /<sheet\b[^>]*>/.exec(wb)?.[0] ?? '';
  const rid = /r:id="([^"]+)"/.exec(sheet)?.[1];
  if (rid) {
    const relRe = /<Relationship\b[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = relRe.exec(rels)) !== null) {
      const tag = m[0];
      if (new RegExp(`\\bId="${rid}"`).test(tag)) {
        const target = /Target="([^"]+)"/.exec(tag)?.[1];
        if (target) {
          const t = target.replace(/^\//, '');
          return t.startsWith('xl/') ? t : `xl/${t}`;
        }
      }
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

export interface XlsxTable {
  header: string[];
  rows: string[][];
}

/**
 * Parse the first worksheet. Row 1 is the header; the remaining rows are
 * data. Cells are positioned by their `r="C5"` reference so omitted (empty)
 * cells keep the row aligned. Trailing fully-empty rows are dropped; every
 * row is padded/truncated to the header width.
 */
export function parseXlsx(buf: Buffer | Uint8Array, opts: { maxRows?: number } = {}): XlsxTable {
  let zip: AdmZip;
  try {
    zip = new AdmZip(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  } catch {
    throw new XlsxParseError('invalid_xlsx');
  }
  const sheetPath = firstSheetPath(zip);
  const sheetXml = zip.getEntry(sheetPath)?.getData().toString('utf8');
  if (!sheetXml) throw new XlsxParseError('invalid_xlsx');
  const shared = parseSharedStrings(
    zip.getEntry('xl/sharedStrings.xml')?.getData().toString('utf8') ?? null,
  );

  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  // A cell is either self-closing (<c r="B2" s="1"/>) or has content.
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    if (opts.maxRows !== undefined && rows.length > opts.maxRows + 1) break;
    const cells: string[] = [];
    const body = rm[1] ?? '';
    let cm: RegExpExecArray | null;
    let cursor = 0;
    while ((cm = cellRe.exec(body)) !== null) {
      const attrs = cm[1] ?? '';
      const inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const idx = ref ? columnIndex(ref) : cursor;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      let value = '';
      if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
        value = shared[Number(v)] ?? '';
      } else if (type === 'inlineStr') {
        value = textRuns(inner);
      } else if (type === 'b') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
        value = v === '1' ? 'TRUE' : 'FALSE';
      } else {
        // n (number), str (formula string), e (error), d (ISO date) — take <v> as-is.
        value = xmlUnescape(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
      cursor = idx + 1;
    }
    rows.push(cells);
  }

  // Drop trailing fully-empty rows, then split header / data.
  while (rows.length && rows[rows.length - 1]!.every((c) => c.trim() === '')) rows.pop();
  const headerRaw = rows.shift() ?? [];
  const header = headerRaw.map((h) => h.trim());
  // Trim trailing empty header cells (Excel sometimes records styled blanks).
  while (header.length && header[header.length - 1] === '') header.pop();
  const w = header.length;
  const data = rows
    .map((r) => {
      const out = r.slice(0, Math.max(w, r.length));
      while (out.length < w) out.push('');
      return out;
    })
    .filter((r) => r.some((c) => c.trim() !== ''));
  return { header, rows: data };
}
