// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0224 — native report → PDF template. Every staff report (the generic
// viewer reports, billing realization, payments received, signed forms,
// profitability) renders through this one HTML layout and the shared
// Puppeteer renderer — a real print document, never a screenshot of the
// page view:
//
//   • Letter landscape when the table is wide (> 6 columns), portrait
//     otherwise, with repeating <thead> on every page (Chromium honors
//     `display: table-header-group`) and rows that never split across
//     a page break.
//   • Right-aligned tabular numerals for numeric columns, left text.
//   • Firm header (brand name + logo), report title, subtitle (filters /
//     window), generated-at line, and page X of Y in the footer.
//   • Optional totals row rendered as a double-ruled <tfoot>.
//   • Optional column group headers (e.g. "Chargeable" over two columns).

export interface ReportPdfColumn {
  /** Header label. */
  label: string;
  /** Second header line (e.g. "(A)" / "(D=B+C)"). */
  sub?: string;
  /** right = numeric; left = text. */
  align?: 'left' | 'right';
  /** Relative width hint (CSS width, e.g. "18%"). */
  width?: string;
}

export interface ReportPdfGroupHeader {
  /** Zero-based column index the group starts at. */
  start: number;
  /** Number of columns spanned. */
  span: number;
  label: string;
}

export interface ReportPdfInput {
  title: string;
  subtitle?: string | null;
  firm: { name: string; logoUrl?: string | null; accentColor?: string | null };
  columns: ReportPdfColumn[];
  rows: string[][];
  totals?: string[] | null;
  totalsLabel?: string;
  groupHeaders?: ReportPdfGroupHeader[];
  generatedAt?: Date;
  /** Force orientation; default auto by column count. */
  orientation?: 'portrait' | 'landscape';
}

function esc(v: string): string {
  return v.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

export function buildReportPdfHtml(input: ReportPdfInput): string {
  const accent = input.firm.accentColor || '#0f6cbd';
  const landscape =
    input.orientation === 'landscape' ||
    (input.orientation !== 'portrait' && input.columns.length > 6);
  const generated = (input.generatedAt ?? new Date()).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const colgroup = input.columns
    .map((c) => `<col${c.width ? ` style="width:${esc(c.width)}"` : ''}>`)
    .join('');

  // Optional group header row (e.g. "Chargeable" spanning A+B).
  let groupRow = '';
  if (input.groupHeaders && input.groupHeaders.length > 0) {
    const cells: string[] = [];
    let i = 0;
    const sorted = [...input.groupHeaders].sort((a, b) => a.start - b.start);
    for (const g of sorted) {
      if (g.start > i) cells.push(`<th class="gh blank" colspan="${g.start - i}"></th>`);
      cells.push(`<th class="gh" colspan="${g.span}">${esc(g.label)}</th>`);
      i = g.start + g.span;
    }
    if (i < input.columns.length) {
      cells.push(`<th class="gh blank" colspan="${input.columns.length - i}"></th>`);
    }
    groupRow = `<tr>${cells.join('')}</tr>`;
  }

  const headRow = `<tr>${input.columns
    .map(
      (c) =>
        `<th class="${c.align === 'right' ? 'num' : 'txt'}">${esc(c.label)}${
          c.sub ? `<span class="sub">${esc(c.sub)}</span>` : ''
        }</th>`,
    )
    .join('')}</tr>`;

  const body = input.rows
    .map(
      (r) =>
        `<tr>${r
          .map(
            (cell, i) =>
              `<td class="${input.columns[i]?.align === 'right' ? 'num' : 'txt'}">${esc(
                cell ?? '',
              )}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');

  const foot =
    input.totals && input.totals.length > 0
      ? `<tfoot><tr class="totals">${input.totals
          .map((cell, i) => {
            const isLabel = i === 0;
            const content = isLabel ? esc(input.totalsLabel ?? cell ?? 'Totals') : esc(cell ?? '');
            return `<td class="${input.columns[i]?.align === 'right' ? 'num' : 'txt'}">${content}</td>`;
          })
          .join('')}</tr></tfoot>`
      : '';

  const logo = input.firm.logoUrl
    ? `<img class="logo" src="${esc(input.firm.logoUrl)}" alt="" />`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: Letter ${landscape ? 'landscape' : 'portrait'}; margin: 0.55in 0.5in 0.6in 0.5in; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #111; font-size: 9.5pt; }
  .hdr { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 2px solid ${accent}; padding-bottom: 6pt; margin-bottom: 10pt; }
  .hdr .firm { display: flex; align-items: center; gap: 10pt; }
  .logo { max-height: 30pt; max-width: 140pt; object-fit: contain; }
  .firmname { font-size: 12pt; font-weight: 600; color: ${accent}; }
  .title { text-align: right; }
  .title h1 { margin: 0; font-size: 15pt; font-weight: 700; }
  .title .sub { font-size: 9pt; color: #555; margin-top: 2pt; }
  .meta { font-size: 8pt; color: #777; margin-bottom: 8pt; }
  table { width: 100%; border-collapse: collapse; table-layout: auto; }
  thead { display: table-header-group; }
  tfoot { display: table-row-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  th, td { padding: 3.5pt 6pt; vertical-align: bottom; }
  th { font-size: 8.5pt; font-weight: 600; color: #333; border-bottom: 1.5px solid #333; background: #f5f5f5; white-space: nowrap; }
  th .sub { display: block; font-weight: 400; font-size: 7.5pt; color: #666; }
  th.gh { font-size: 8pt; font-weight: 600; color: #444; text-align: center; border-bottom: 1px solid #999; background: transparent; }
  th.gh.blank { border-bottom: none; }
  td { border-bottom: 0.5px solid #ddd; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .txt { text-align: left; }
  tbody tr:nth-child(even) td { background: #fafafa; }
  tfoot .totals td { font-weight: 700; border-top: 1.5px solid #111; border-bottom: 3px double #111; background: #fff; padding-top: 5pt; padding-bottom: 5pt; }
  .empty { padding: 14pt; color: #777; text-align: center; }
</style>
</head>
<body>
  <div class="hdr">
    <div class="firm">${logo}<span class="firmname">${esc(input.firm.name)}</span></div>
    <div class="title"><h1>${esc(input.title)}</h1>${
      input.subtitle ? `<div class="sub">${esc(input.subtitle)}</div>` : ''
    }</div>
  </div>
  <div class="meta">Generated ${esc(generated)} · ${input.rows.length} row${
    input.rows.length === 1 ? '' : 's'
  }</div>
  ${
    input.rows.length === 0
      ? `<div class="empty">No data for the selected filters.</div>`
      : `<table><colgroup>${colgroup}</colgroup><thead>${groupRow}${headRow}</thead><tbody>${body}</tbody>${foot}</table>`
  }
</body>
</html>`;
}

/** Puppeteer header/footer templates (page X of Y). */
export const REPORT_PDF_FOOTER_TEMPLATE = `<div style="width:100%;font-size:7.5pt;color:#777;padding:0 0.5in;display:flex;justify-content:space-between;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;"><span class="title"></span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
export const REPORT_PDF_HEADER_TEMPLATE = `<div></div>`;
