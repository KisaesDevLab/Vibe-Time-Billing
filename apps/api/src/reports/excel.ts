// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Lightweight Excel export (Phase 17 #23). Renders the rows as an
// HTML table with the Excel MIME type — every desktop Excel /
// LibreOffice opens this natively, no SheetJS dependency required.
// Numeric columns get x:num annotations so Excel doesn't store them
// as strings.

export interface ExcelColumn<T> {
  header: string;
  render: (row: T) => string | number | null | undefined;
  numeric?: boolean;
}

export function excelTable<T>(args: { columns: ExcelColumn<T>[]; rows: T[]; title?: string }): {
  body: string;
  mime: string;
  ext: string;
} {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const headerHtml = `<tr>${args.columns.map((c) => `<th>${esc(c.header)}</th>`).join('')}</tr>`;
  const rowsHtml = args.rows
    .map(
      (r) =>
        `<tr>${args.columns
          .map((c) => {
            const v = c.render(r);
            if (v == null) return '<td></td>';
            if (c.numeric && typeof v === 'number') {
              return `<td x:num="${v}">${v}</td>`;
            }
            return `<td>${esc(String(v))}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  const body = `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:x="urn:schemas-microsoft-com:office:excel"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="utf-8"/>
  <title>${esc(args.title ?? 'export')}</title>
  <style>
    table { border-collapse: collapse; }
    th { background: #f4f6f9; font-weight: 600; text-align: left; }
    th, td { border: 1px solid #d0d7de; padding: 4px 8px; font: 12px Arial, sans-serif; }
  </style>
</head>
<body>
  <table>
    <thead>${headerHtml}</thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;
  return {
    body,
    mime: 'application/vnd.ms-excel; charset=utf-8',
    ext: 'xls',
  };
}
