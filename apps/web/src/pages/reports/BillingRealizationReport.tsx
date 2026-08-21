// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0223 — Billing realization report. The classic practice-management
// layout: ID · Name · Hours (A) · Amount (B) · Adjusted (C) · Fee Amt
// (D=B+C) · Charge Rate (B/A) · Fee Rate (D/A) · Real % (D/B), with a
// Report Totals row. Same billed-WIP universe and invoice-date window as
// the Realization card; grouped by timekeeper, service line, engagement
// type, client, or engagement. Backed by GET /api/staff/reports/
// billing-realization.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, Combobox, Input, SectionHeading, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { downloadReportPdf } from '../../lib/report-pdf';

type Dimension =
  | 'timekeeper'
  | 'service_line'
  | 'engagement_type'
  | 'client'
  | 'engagement'
  | 'firm_owner'
  | 'location'
  | 'entity_type'
  | 'client_zip';

interface ReportRow {
  key: string;
  code: string;
  name: string;
  hours: number;
  originalValueCents: number;
  adjustmentCents: number;
  adjustedValueCents: number;
  chargeRateCents: number;
  feeRateCents: number;
  realizationPct: number;
}

interface Totals {
  hours: number;
  originalValueCents: number;
  adjustmentCents: number;
  adjustedValueCents: number;
  chargeRateCents: number;
  feeRateCents: number;
  realizationPct: number;
}

const DIMENSIONS: { value: Dimension; label: string }[] = [
  { value: 'timekeeper', label: 'By timekeeper' },
  { value: 'service_line', label: 'By service line' },
  { value: 'engagement_type', label: 'By engagement type' },
  { value: 'client', label: 'By client' },
  { value: 'engagement', label: 'By engagement' },
  { value: 'firm_owner', label: 'By firm owner (partner in charge)' },
  { value: 'location', label: 'By location (office)' },
  { value: 'entity_type', label: 'By client entity type' },
  { value: 'client_zip', label: 'By client zip code' },
];

function money(cents: number): string {
  const v = cents / 100;
  const s = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return v < 0 ? `-${s}` : s;
}
function hrs(h: number): string {
  return h.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(p: number): string {
  return (p * 100).toFixed(2);
}

function yearStart(): string {
  return `${new Date().getFullYear()}-01-01`;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BillingRealizationReportPage(): JSX.Element {
  const [dimension, setDimension] = useState<Dimension>('timekeeper');
  const [start, setStart] = useState(yearStart());
  const [end, setEnd] = useState(today());
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  const query = `dimension=${dimension}&start=${start}&end=${end}`;

  async function exportPdf(): Promise<void> {
    setPdfBusy(true);
    try {
      const dimLabel = DIMENSIONS.find((d) => d.value === dimension)?.label ?? dimension;
      await downloadReportPdf({
        title: 'Billing Realization',
        subtitle: `${dimLabel} · Invoice dates ${start} to ${end}`,
        orientation: 'landscape',
        groupHeaders: [{ start: 2, span: 2, label: 'Chargeable' }],
        columns: [
          { label: 'ID', align: 'left', width: '9%' },
          { label: 'Name/Description', align: 'left', width: '25%' },
          { label: 'Hours/Units', sub: '(A)', align: 'right' },
          { label: 'Amount', sub: '(B)', align: 'right' },
          { label: 'Adjusted', sub: '(C)', align: 'right' },
          { label: 'Fee Amt', sub: '(D=B+C)', align: 'right' },
          { label: 'Charge Rate', sub: '(B/A)', align: 'right' },
          { label: 'Fee Rate', sub: '(D/A)', align: 'right' },
          { label: 'Real %', sub: '(D/B)', align: 'right' },
        ],
        rows: rows.map((r) => [
          r.code,
          r.name,
          hrs(r.hours),
          money(r.originalValueCents),
          money(r.adjustmentCents),
          money(r.adjustedValueCents),
          money(r.chargeRateCents),
          money(r.feeRateCents),
          pct(r.realizationPct),
        ]),
        totals: totals
          ? [
              'Report Totals',
              '',
              hrs(totals.hours),
              money(totals.originalValueCents),
              money(totals.adjustmentCents),
              money(totals.adjustedValueCents),
              money(totals.chargeRateCents),
              money(totals.feeRateCents),
              pct(totals.realizationPct),
            ]
          : undefined,
        totalsLabel: 'Report Totals',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'pdf_failed');
    } finally {
      setPdfBusy(false);
    }
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void api<{ rows: ReportRow[]; totals: Totals | null }>(
      `/api/staff/reports/billing-realization?${query}`,
    )
      .then((r) => {
        if (!alive) return;
        setRows(r.rows ?? []);
        setTotals(r.totals);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'load_failed'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [query]);

  const th = (label: string, sub?: string, align: 'left' | 'right' = 'right'): JSX.Element => (
    <th
      style={{
        textAlign: align,
        padding: '6px 10px',
        fontSize: 12,
        fontWeight: 600,
        color: tokens.color.textMuted,
        borderBottom: `2px solid ${tokens.color.border}`,
        whiteSpace: 'nowrap',
        verticalAlign: 'bottom',
      }}
    >
      {label}
      {sub && <div style={{ fontWeight: 400, fontSize: 11 }}>{sub}</div>}
    </th>
  );
  const td = (content: string, align: 'left' | 'right' = 'right', mono = true): JSX.Element => (
    <td
      style={{
        textAlign: align,
        padding: '6px 10px',
        fontSize: 13,
        fontFamily: mono ? tokens.font.mono : tokens.font.body,
        fontVariantNumeric: 'tabular-nums',
        borderBottom: `1px solid ${tokens.color.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {content}
    </td>
  );

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <div>
        <Link to="/reports" style={{ fontSize: 13, color: tokens.color.accent }}>
          ← Reports
        </Link>
      </div>
      <SectionHeading
        title="Billing realization"
        description="Billed hours at standard value, net adjustments, and resulting fees — windowed by invoice date. Real % = Fee Amt ÷ Amount."
        action={
          <span style={{ display: 'flex', gap: 6 }}>
            <Button
              size="sm"
              onClick={() => void exportPdf()}
              disabled={pdfBusy || rows.length === 0}
            >
              {pdfBusy ? 'Rendering…' : 'Export PDF'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                window.open(
                  `/api/staff/reports/billing-realization?${query}&format=csv`,
                  '_blank',
                  'noopener',
                )
              }
            >
              Export CSV
            </Button>
          </span>
        }
      />
      <Card>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ width: 220 }}>
            <span
              style={{
                fontSize: 12,
                color: tokens.color.textMuted,
                display: 'block',
                marginBottom: 4,
              }}
            >
              Group by
            </span>
            <Combobox
              ariaLabel="Group by"
              value={dimension}
              onChange={(v) => setDimension(v as Dimension)}
              options={DIMENSIONS}
            />
          </div>
          <Input
            label="From (invoice date)"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <Input label="To" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setStart(yearStart());
              setEnd(today());
            }}
          >
            This year
          </Button>
        </div>
      </Card>

      <Card>
        {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th colSpan={2} style={{ borderBottom: 'none' }} />
                <th
                  colSpan={2}
                  style={{
                    textAlign: 'center',
                    fontSize: 11,
                    fontWeight: 600,
                    color: tokens.color.textMuted,
                    borderBottom: `1px solid ${tokens.color.border}`,
                    padding: '2px 10px',
                  }}
                >
                  Chargeable
                </th>
                <th colSpan={5} style={{ borderBottom: 'none' }} />
              </tr>
              <tr>
                {th('ID', undefined, 'left')}
                {th('Name/Description', undefined, 'left')}
                {th('Hours/Units', '(A)')}
                {th('Amount', '(B)')}
                {th('Adjusted', '(C)')}
                {th('Fee Amt', '(D=B+C)')}
                {th('Charge Rate', '(B/A)')}
                {th('Fee Rate', '(D/A)')}
                {th('Real %', '(D/B)')}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    style={{ padding: 12, fontSize: 13, color: tokens.color.textMuted }}
                  >
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    style={{ padding: 12, fontSize: 13, color: tokens.color.textMuted }}
                  >
                    No billed time in this window.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.key}>
                  {td(r.code, 'left')}
                  {td(r.name, 'left', false)}
                  {td(hrs(r.hours))}
                  {td(money(r.originalValueCents))}
                  {td(money(r.adjustmentCents))}
                  {td(money(r.adjustedValueCents))}
                  {td(money(r.chargeRateCents))}
                  {td(money(r.feeRateCents))}
                  {td(pct(r.realizationPct))}
                </tr>
              ))}
            </tbody>
            {totals && rows.length > 0 && (
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td
                    colSpan={2}
                    style={{
                      padding: '8px 10px',
                      fontSize: 13,
                      borderTop: `2px solid ${tokens.color.text}`,
                      borderBottom: `3px double ${tokens.color.text}`,
                    }}
                  >
                    Report Totals
                  </td>
                  {[
                    hrs(totals.hours),
                    money(totals.originalValueCents),
                    money(totals.adjustmentCents),
                    money(totals.adjustedValueCents),
                    money(totals.chargeRateCents),
                    money(totals.feeRateCents),
                    pct(totals.realizationPct),
                  ].map((v, i) => (
                    <td
                      key={i}
                      style={{
                        textAlign: 'right',
                        padding: '8px 10px',
                        fontSize: 13,
                        fontFamily: tokens.font.mono,
                        fontVariantNumeric: 'tabular-nums',
                        borderTop: `2px solid ${tokens.color.text}`,
                        borderBottom: `3px double ${tokens.color.text}`,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {v}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>
    </div>
  );
}
