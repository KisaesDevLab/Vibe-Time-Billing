// SPDX-License-Identifier: Elastic-2.0
//
// Printable "Appointments" table, rendered to PDF by
// apps/api/src/pdf/render.ts (Puppeteer). One row per appointment in the
// order received, so the PDF matches the on-screen (client-filtered,
// client-sorted) table exactly. Date/time/staff are passed as pre-
// formatted display strings from the browser to avoid timezone drift.
// Pure function (data in → HTML out).

export interface AppointmentsListPdfRow {
  date: string;
  time: string;
  title: string;
  staff: string;
  client: string;
  engagement: string;
  location: string;
  status: string;
}

export interface AppointmentsListPdfData {
  firmName: string;
  generatedAt: string;
  filterSummary: string[];
  rows: AppointmentsListPdfRow[];
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function val(s: string | null | undefined): string {
  return s && s.trim() ? esc(s) : '—';
}

export function renderAppointmentsListHtml(data: AppointmentsListPdfData): string {
  const body =
    data.rows.length === 0
      ? `<tr><td colspan="7" class="empty">No appointments match these filters.</td></tr>`
      : data.rows
          .map(
            (r) => `<tr>
        <td class="nowrap"><div>${val(r.date)}</div><div class="muted">${val(r.time)}</div></td>
        <td>${val(r.title)}</td>
        <td>${val(r.staff)}</td>
        <td>${val(r.client)}</td>
        <td>${val(r.engagement)}</td>
        <td>${val(r.location)}</td>
        <td class="nowrap">${val(r.status)}</td>
      </tr>`,
          )
          .join('\n');

  const summary =
    data.filterSummary.length > 0
      ? `<div class="filters">${data.filterSummary.map((s) => `<span>${esc(s)}</span>`).join('')}</div>`
      : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; font-size: 11px; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 8px; }
  .firm { font-size: 16px; font-weight: 700; }
  .title { font-size: 13px; font-weight: 600; color: #444; }
  .gen { font-size: 10px; color: #666; text-align: right; }
  .filters { margin: 4px 0 10px; font-size: 10px; color: #333; }
  .filters span { display: inline-block; background: #f1f3f5; border-radius: 4px; padding: 2px 6px; margin: 0 4px 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; color: #555;
       border-bottom: 1px solid #999; padding: 5px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #e3e3e3; vertical-align: top; }
  tr { page-break-inside: avoid; }
  .muted { color: #777; font-size: 10px; }
  .nowrap { white-space: nowrap; }
  .empty { text-align: center; color: #777; padding: 16px; }
</style>
</head>
<body>
  <div class="head">
    <div>
      <div class="firm">${val(data.firmName)}</div>
      <div class="title">Appointments</div>
    </div>
    <div class="gen">Generated ${val(data.generatedAt)}<br/>${data.rows.length} appointment${data.rows.length === 1 ? '' : 's'}</div>
  </div>
  ${summary}
  <table>
    <thead>
      <tr>
        <th>Date &amp; time</th>
        <th>Subject</th>
        <th>Staff</th>
        <th>Client</th>
        <th>Engagement</th>
        <th>Location</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      ${body}
    </tbody>
  </table>
</body>
</html>`;
}
