// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CSV cell encoding with formula-injection neutralization. Spreadsheet apps
// (Excel, LibreOffice, Sheets) treat a cell beginning with = + - @ — or a
// tab / CR that lets one of those lead — as a live formula. User-controlled
// data (client names, descriptions, references) flows into our exports, so
// any such cell is prefixed with a single quote to force literal text, then
// RFC-4180 quote-escaped.

/** True when `s` would be interpreted as a formula by a spreadsheet. */
function looksLikeFormula(s: string): boolean {
  return /^[=+\-@\t\r]/.test(s);
}

/** Encode one CSV field: neutralize formulas, then quote/escape as needed. */
export function csvField(value: string | number | null | undefined): string {
  if (value == null) return '';
  let s = String(value);
  if (looksLikeFormula(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
