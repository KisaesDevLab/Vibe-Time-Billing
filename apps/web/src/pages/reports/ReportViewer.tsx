// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Generic report viewer. Renders any reporting endpoint that returns either a
// `{ items: [...] }` array or a flat object of scalars, as a table + summary
// strip with CSV export. Surfaces the reports that have no bespoke UI, and is
// the destination for the saved-reports "Open" action.

import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { Button, Card, Input, Table, tokens } from '@vibe/ui';

import { api, getCsrfToken } from '../../api-client';

export interface ParamSpec {
  name: string;
  label: string;
  placeholder?: string;
  /** When set, render a segmented toggle over these values instead of a text input. */
  options?: readonly string[];
}
export interface ReportSpec {
  kind: string;
  label: string;
  description: string;
  params?: ParamSpec[];
}

const DATE_PARAMS: ParamSpec[] = [
  { name: 'start', label: 'Start (YYYY-MM-DD)' },
  { name: 'end', label: 'End (YYYY-MM-DD)' },
];

// MyBooks-style revenue-basis toggle: accrual = billed on invoice issue
// date; cash = actually collected, dated by payment receipt.
const BASIS_PARAM: ParamSpec = { name: 'basis', label: 'Basis', options: ['accrual', 'cash'] };

// API-only reports surfaced through the generic viewer. Reports that have a
// dedicated page (realization, dso/mrr/revenue-ops, profitability,
// payments-received, signed-forms) are linked to those pages instead.
export const VIEWER_REPORTS: ReportSpec[] = [
  {
    kind: 'realization-by-partner',
    label: 'Realization by partner',
    description:
      'Billing realization (amount billed ÷ billed WIP at standard) grouped by partner in charge; window = invoice date.',
    params: DATE_PARAMS,
  },
  {
    kind: 'revenue-by-month',
    label: 'Revenue by month',
    description:
      'Per calendar month (last 24): billed + paid on accrual basis, or net cash collected on cash basis.',
    params: [...DATE_PARAMS, BASIS_PARAM],
  },
  {
    kind: 'revenue-period-over-period',
    label: 'Revenue period-over-period',
    description:
      'Month-over-month revenue change — billed on accrual basis, net cash collected on cash basis.',
    params: [...DATE_PARAMS, BASIS_PARAM],
  },
  {
    kind: 'utilization',
    label: 'Utilization',
    description: 'Billable vs total and vs available capacity (default 30 days).',
    params: DATE_PARAMS,
  },
  {
    kind: 'non-billable-breakdown',
    label: 'Non-billable breakdown',
    description:
      'Where non-billable time went, by work code (CPE, meetings, marketing …), split firm-admin vs client engagements (default 30 days).',
    params: DATE_PARAMS,
  },
  {
    kind: 'effective-rate',
    label: 'Effective rate',
    description: 'Billed value ÷ billable hours per timekeeper (default 90 days).',
    params: DATE_PARAMS,
  },
  {
    kind: 'time-by-staff-week',
    label: 'Time by staff (weekly)',
    description:
      'One row per staff member per week: Mon–Sun day hours and the week total (default 8 weeks).',
    params: DATE_PARAMS,
  },
  {
    kind: 'time-by-engagement',
    label: 'Time by engagement',
    description: 'Hours + standard value per engagement.',
    params: DATE_PARAMS,
  },
  {
    kind: 'time-by-client',
    label: 'Time by client',
    description: 'Hours + standard value per client.',
    params: DATE_PARAMS,
  },
  {
    kind: 'collection-realization',
    label: 'Collection realization',
    description:
      'Paid ÷ billed per partner (default 90 days). Cash basis counts money received in the window; accrual uses lifetime paid on invoices issued in it.',
    params: [...DATE_PARAMS, BASIS_PARAM],
  },
  {
    kind: 'book-of-business',
    label: 'Book of business',
    description:
      'Active clients + billed/paid per partner (default 365 days). Cash basis dates "paid" by payment receipt.',
    params: [...DATE_PARAMS, BASIS_PARAM],
  },
  {
    kind: 'clv',
    label: 'Client lifetime value',
    description: 'Lifetime paid + billed revenue per client (top 200).',
  },
  {
    kind: 'firm-profitability',
    label: 'Firm profitability',
    description:
      'Cost, billed, paid, and margin per engagement. Margin = billed − cost on accrual basis, collected − cost on cash basis.',
    params: [...DATE_PARAMS, BASIS_PARAM],
  },
  {
    kind: 'capacity-forecast',
    label: 'Capacity forecast',
    description: 'Projected next-4-week billable hours vs target and per-user capacity.',
    params: [
      { name: 'weeklyTarget', label: 'Weekly target hrs', placeholder: '32' },
      ...DATE_PARAMS,
    ],
  },
  {
    kind: 'productivity-by-office',
    label: 'Productivity by office',
    description: 'Hours + utilization per office.',
    params: [{ name: 'days', label: 'Window (days)', placeholder: '30' }],
  },
  {
    kind: 'billable-targets',
    label: 'Billable targets',
    description: 'Month-to-date billable hours vs the (prorated) monthly target.',
    params: [{ name: 'target', label: 'Target override', placeholder: 'firm default' }],
  },
  {
    kind: 'scope-creep',
    label: 'Scope creep',
    description: 'Out-of-scope hours per mixed-mode engagement.',
    params: DATE_PARAMS,
  },
  {
    kind: 'approval-metrics',
    label: 'Approval metrics',
    description: 'Approval counts, rates, and response time per approver (default 90 days).',
    params: [{ name: 'days', label: 'Window (days)', placeholder: '90' }],
  },
  {
    kind: 'time-anomalies',
    label: 'Time anomalies',
    description: 'Per-timekeeper daily-hours outliers (z-score, default 90 days).',
    params: DATE_PARAMS,
  },
  {
    kind: 'payroll-period',
    label: 'Payroll period',
    description:
      'One row per employee for the pay period containing the given date (default today): regular, OT, PTO, sick, comp, holiday, and unpaid hours. Locking + approval live on the Payroll review page.',
    params: [{ name: 'date', label: 'Any date in the period (YYYY-MM-DD)' }],
  },
  {
    kind: 'time-off-balances',
    label: 'Time-off balances',
    description:
      'Accrued vs used vs current balance per employee per bank (PTO / Sick / Comp) — for year-end review and PTO-liability accruals.',
  },
  {
    kind: 'subscription-profitability',
    label: 'Subscription profitability',
    description: 'Retainer revenue vs cost-to-serve over a trailing window.',
    params: [
      { name: 'days', label: 'Window (days)', placeholder: '90' },
      { name: 'start', label: 'Start (YYYY-MM-DD)' },
    ],
  },
  {
    kind: 'client-request-capture',
    label: 'Client-request capture',
    description: 'Billable time captured against fulfilled client requests.',
    params: [
      { name: 'start', label: 'Start (YYYY-MM-DD)' },
      { name: 'end', label: 'End (YYYY-MM-DD)' },
    ],
  },
];

const SPEC_BY_KIND = new Map(VIEWER_REPORTS.map((s) => [s.kind, s]));

function fmtCell(key: string, val: unknown): string {
  if (val == null) return '—';
  if (typeof val === 'number') {
    if (/Cents$/.test(key))
      return `$${(val / 100).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    if (/Pct$/.test(key)) {
      // realizationPct is ALWAYS a 0–1 ratio (a 1.6 write-up used to slip
      // past the magnitude heuristic and render as "1.6%"); other *Pct
      // fields are 0–100 unless small enough to be an obvious ratio.
      const pct = key === 'realizationPct' || Math.abs(val) <= 1.5 ? val * 100 : val;
      return `${pct.toFixed(1)}%`;
    }
    return Number.isInteger(val)
      ? val.toLocaleString()
      : val.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function humanize(key: string): string {
  return key
    .replace(/Cents$/, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

type Row = Record<string, unknown> & { __i: number };

export function ReportViewerPage(): JSX.Element {
  const { kind = '' } = useParams();
  const [, setSearch] = useSearchParams();
  const spec = SPEC_BY_KIND.get(kind);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paramVals, setParamVals] = useState<Record<string, string>>({});

  // Seed param inputs from the query string when the report changes.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const init: Record<string, string> = {};
    for (const p of spec?.params ?? []) init[p.name] = sp.get(p.name) ?? '';
    setParamVals(init);
    if (kind) void run(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function run(vals: Record<string, string>): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      for (const p of spec?.params ?? []) if (vals[p.name]) qs.set(p.name, vals[p.name]!);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const r = await api<Record<string, unknown>>(`/api/staff/reports/${kind}${suffix}`);
      setData(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }

  const items = useMemo<Row[] | null>(() => {
    const raw = data && (data as { items?: unknown }).items;
    if (!Array.isArray(raw)) return null;
    return raw.map((r, i) => ({ ...(r as Record<string, unknown>), __i: i }));
  }, [data]);

  const columns = useMemo(() => {
    if (!items || items.length === 0) return [];
    const keys = new Set<string>();
    for (const row of items.slice(0, 50))
      for (const k of Object.keys(row)) if (!k.startsWith('__')) keys.add(k);
    // Raw uuids are meaningless to the reader — hide id columns outright
    // (every report endpoint returns a human-readable name field; ids stay
    // in the payload for drill-through, they just don't render). `key` is
    // the realization rollup's id twin and hides whenever `label` exists.
    for (const k of [...keys]) {
      if (k === 'id' || /Id$/.test(k)) keys.delete(k);
    }
    if (keys.has('key') && keys.has('label')) keys.delete('key');
    return Array.from(keys);
  }, [items]);

  const metaEntries = useMemo(() => {
    if (!data) return [];
    return Object.entries(data).filter(
      ([k, v]) => k !== 'items' && (typeof v !== 'object' || v == null),
    );
  }, [data]);

  function downloadCsv(): void {
    if (!items || columns.length === 0) return;
    // CSV is a DATA export: include the id columns hidden from the table so
    // two same-named rows (e.g. "1040 Prep" for different clients) stay
    // distinguishable downstream.
    const keys = new Set<string>();
    for (const row of items.slice(0, 50))
      for (const k of Object.keys(row)) if (!k.startsWith('__')) keys.add(k);
    const exportColumns = Array.from(keys);
    const esc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [exportColumns.map(esc).join(',')];
    for (const row of items)
      lines.push(exportColumns.map((c) => esc(String(row[c] ?? ''))).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadPdf(): Promise<void> {
    if (!items || columns.length === 0) return;
    // Send the already-fetched, formatted rows keyed by human column labels so
    // the server-rendered PDF shows names / currency / % just like the table.
    const headers = columns.map((c) => humanize(c));
    const payloadRows = items.map((row) =>
      Object.fromEntries(columns.map((c) => [humanize(c), fmtCell(c, row[c])])),
    );
    const csrf = getCsrfToken();
    const res = await fetch('/api/staff/reports/pdf', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: JSON.stringify({ title: spec?.label ?? kind, columns: headers, rows: payloadRows }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${kind}-${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!spec) {
    return (
      <Card title="Unknown report">
        <p style={{ fontSize: 13 }}>No report named “{kind}”.</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card
        title={spec.label}
        action={
          items && items.length > 0 ? (
            <span style={{ display: 'inline-flex', gap: 6 }}>
              <Button size="sm" variant="secondary" onClick={downloadCsv}>
                ⬇ CSV
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void downloadPdf()}>
                ⬇ PDF
              </Button>
            </span>
          ) : undefined
        }
      >
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          {spec.description}
        </p>
        {spec.params && spec.params.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-end',
              marginBottom: 12,
              flexWrap: 'wrap',
            }}
          >
            {spec.params.map((p) =>
              p.options ? (
                <div key={p.name} style={{ display: 'grid', gap: 4 }}>
                  <span style={{ fontSize: 11, color: tokens.color.textMuted }}>{p.label}</span>
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    {p.options.map((opt) => {
                      const active = (paramVals[p.name] || p.options![0]) === opt;
                      return (
                        <Button
                          key={opt}
                          size="sm"
                          variant={active ? 'primary' : 'secondary'}
                          onClick={() => {
                            const vals = { ...paramVals, [p.name]: opt };
                            setParamVals(vals);
                            const next = new URLSearchParams();
                            for (const sp of spec.params ?? [])
                              if (vals[sp.name]) next.set(sp.name, vals[sp.name]!);
                            setSearch(next);
                            void run(vals);
                          }}
                        >
                          {opt.charAt(0).toUpperCase() + opt.slice(1)}
                        </Button>
                      );
                    })}
                  </span>
                </div>
              ) : (
                <Input
                  key={p.name}
                  label={p.label}
                  value={paramVals[p.name] ?? ''}
                  placeholder={p.placeholder}
                  onChange={(e) => setParamVals((s) => ({ ...s, [p.name]: e.target.value }))}
                  style={{ width: 160 }}
                />
              ),
            )}
            <Button
              size="sm"
              onClick={() => {
                const next = new URLSearchParams();
                for (const p of spec.params ?? [])
                  if (paramVals[p.name]) next.set(p.name, paramVals[p.name]!);
                setSearch(next);
                void run(paramVals);
              }}
            >
              Run
            </Button>
          </div>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        {metaEntries.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 12 }}>
            {metaEntries.map(([k, v]) => (
              <div key={k} style={{ fontSize: 13 }}>
                <span style={{ color: tokens.color.textMuted }}>{humanize(k)}: </span>
                <strong>{fmtCell(k, v)}</strong>
              </div>
            ))}
          </div>
        )}
        {items ? (
          <Table<Row>
            columns={columns.map((c) => ({
              key: c,
              header: humanize(c),
              align: /Cents$|Pct$|Hours$|Count$|Days$|Rate/.test(c)
                ? ('right' as const)
                : ('left' as const),
              render: (row: Row) => fmtCell(c, row[c]),
            }))}
            rows={items}
            rowKey={(r) => String(r.__i)}
            empty={loading ? 'Loading…' : 'No rows.'}
          />
        ) : (
          <p style={{ fontSize: 13 }}>
            {loading ? 'Loading…' : 'No tabular data for this report.'}
          </p>
        )}
      </Card>
    </div>
  );
}
