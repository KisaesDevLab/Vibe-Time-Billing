// SPDX-License-Identifier: Elastic-2.0
//
// R6-followup — CSV + PDF export helpers for the retainer surface.
//
//   buildLedgerCsv      — full ledger for a single retainer (staff use).
//                          Includes time_entry_id + actor for forensic
//                          drill-down; never exposed to the client portal.
//   buildOfferFunnelCsv — offer-stage counts grouped by date for a
//                          window. Used by partner/firm dashboards.
//   buildActivityStatementHtml — client-facing privacy-filtered HTML
//                          rendered to PDF via the existing Puppeteer
//                          adapter. Strips description, app_user_id,
//                          and any staff name.

import { csvField } from '../lib/csv';

const CSV_HEADER_LEDGER =
  'created_at,kind,hours_delta,hours_balance_after,time_entry_id,created_by_id';

export interface LedgerRow {
  createdAt: Date | string;
  kind: 'ACTIVATION' | 'CONSUME' | 'REVERSE';
  hoursDelta: string | number;
  hoursBalanceAfter: string | number;
  timeEntryId: string | null;
  createdById: string | null;
}

export function buildLedgerCsv(rows: LedgerRow[]): string {
  const lines = [CSV_HEADER_LEDGER];
  for (const r of rows) {
    const ts =
      r.createdAt instanceof Date
        ? r.createdAt.toISOString()
        : new Date(String(r.createdAt)).toISOString();
    lines.push(
      [
        ts,
        r.kind,
        String(r.hoursDelta),
        String(r.hoursBalanceAfter),
        r.timeEntryId ?? '',
        r.createdById ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export interface OfferFunnelRow {
  bucket: string; // ISO YYYY-MM-DD
  pendingCount: number;
  pendingPaymentCount: number;
  purchasedCount: number;
  declinedCount: number;
  expiredCount: number;
}

const CSV_HEADER_FUNNEL = 'date_bucket,pending,pending_payment,purchased,declined,expired';

export function buildOfferFunnelCsv(rows: OfferFunnelRow[]): string {
  const lines = [CSV_HEADER_FUNNEL];
  for (const r of rows) {
    lines.push(
      [
        r.bucket,
        r.pendingCount,
        r.pendingPaymentCount,
        r.purchasedCount,
        r.declinedCount,
        r.expiredCount,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

// Activity statement — Puppeteer renders this HTML. Privacy filter is
// applied at the SELECT layer; we render whatever the caller passes.

export interface ActivityStatementInput {
  firmName: string;
  clientName: string;
  retainer: {
    name: string;
    returnType: string;
    taxYear: number;
    tier: 'TIER_1' | 'TIER_2';
    hoursPurchased: string | number;
    hoursConsumed: string | number;
    purchaseDate: Date | string;
    expiryDate: Date | string;
    status: string;
  };
  /** Privacy-filtered: NO description / app_user_id / staff name. */
  ledger: Array<{
    createdAt: Date | string;
    kind: 'ACTIVATION' | 'CONSUME' | 'REVERSE';
    hoursDelta: string | number;
    hoursBalanceAfter: string | number;
  }>;
  asOfDate: string;
}

export function buildActivityStatementHtml(input: ActivityStatementInput): string {
  const hp = Number(input.retainer.hoursPurchased);
  const hc = Number(input.retainer.hoursConsumed);
  const remaining = hp - hc;
  const purchaseIso = toIsoDate(input.retainer.purchaseDate);
  const expiryIso = toIsoDate(input.retainer.expiryDate);
  const ledgerRows = input.ledger
    .map((row) => {
      const ts = toIsoDate(row.createdAt);
      return `
        <tr>
          <td>${escapeHtml(ts)}</td>
          <td>${escapeHtml(row.kind)}</td>
          <td class="num">${escapeHtml(String(row.hoursDelta))}</td>
          <td class="num">${escapeHtml(String(row.hoursBalanceAfter))}</td>
        </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Retainer Activity Statement</title>
  <style>
    body { font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: #1f2937; margin: 0; padding: 0; }
    .page { padding: 24px; max-width: 720px; margin: 0 auto; }
    header { border-bottom: 2px solid #1f2937; padding-bottom: 12px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 22px; }
    h2 { font-size: 16px; margin: 24px 0 8px; color: #374151; }
    .meta { color: #6b7280; font-size: 13px; margin-top: 4px; }
    .card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; }
    .grid dt { color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; margin: 0; }
    .grid dd { margin: 0 0 6px; font-size: 14px; font-weight: 500; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
    th { background: #f3f4f6; font-weight: 600; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    footer { color: #9ca3af; font-size: 11px; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 12px; }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <h1>Retainer Activity Statement</h1>
      <div class="meta">${escapeHtml(input.firmName)} · ${escapeHtml(input.clientName)} · as of ${escapeHtml(input.asOfDate)}</div>
    </header>

    <h2>Retainer summary</h2>
    <div class="card">
      <dl class="grid">
        <div><dt>Name</dt><dd>${escapeHtml(input.retainer.name)}</dd></div>
        <div><dt>Status</dt><dd>${escapeHtml(input.retainer.status)}</dd></div>
        <div><dt>Return type</dt><dd>${escapeHtml(input.retainer.returnType)} (TY${escapeHtml(String(input.retainer.taxYear))})</dd></div>
        <div><dt>Tier</dt><dd>${escapeHtml(input.retainer.tier)}</dd></div>
        <div><dt>Purchased</dt><dd>${escapeHtml(purchaseIso)}</dd></div>
        <div><dt>Expires</dt><dd>${escapeHtml(expiryIso)}</dd></div>
        <div><dt>Hours purchased</dt><dd>${hp.toFixed(2)}</dd></div>
        <div><dt>Hours consumed</dt><dd>${hc.toFixed(2)}</dd></div>
        <div><dt>Hours remaining</dt><dd><strong>${remaining.toFixed(2)}</strong></dd></div>
      </dl>
    </div>

    <h2>Activity</h2>
    ${
      ledgerRows
        ? `<table>
            <thead>
              <tr><th>Date</th><th>Type</th><th class="num">Hours</th><th class="num">Balance</th></tr>
            </thead>
            <tbody>${ledgerRows}</tbody>
          </table>`
        : `<p style="color:#6b7280">No retainer activity recorded yet.</p>`
    }

    <footer>
      Unused hours forfeit on the expiration date. Contact your firm with any questions
      about activity shown above.
    </footer>
  </div>
</body>
</html>`;
}

function csvCell(v: string | number): string {
  return csvField(v);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toIsoDate(d: Date | string): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return new Date(s).toISOString().slice(0, 10);
}
