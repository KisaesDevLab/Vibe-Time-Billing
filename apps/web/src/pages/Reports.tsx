// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Button, Card, Input, Pill, Sparkline, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { downloadReportPdf } from '../lib/report-pdf';
import { VIEWER_REPORTS } from './reports/ReportViewer';

type Dimension = 'firm' | 'timekeeper' | 'engagement' | 'client' | 'service_line';

interface DimensionItem {
  key: string;
  label: string | null;
  originalValueCents: number;
  adjustedValueCents: number;
  realizationPct: number;
}

interface FirmSummary {
  dimension: 'firm';
  summary: { originalValueCents: number; adjustedValueCents: number; realizationPct: number };
}

interface DimResponse {
  dimension: Exclude<Dimension, 'firm'>;
  items: DimensionItem[];
}

interface PeriodRow {
  month: string;
  // Accrual basis: billed + paid by invoice issue month.
  billedCents?: number;
  paidCents?: number;
  pctChangeBilled?: number | null;
  // Cash basis: net cash collected by payment-receipt month.
  collectedCents?: number;
  pctChangeCollected?: number | null;
}

const formatPct = (p: number): string => `${(p * 100).toFixed(1)}%`;
const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function ninetyDaysAgo(): string {
  return new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
}

export function ReportsPage(): JSX.Element {
  const [search, setSearch] = useSearchParams();
  const dim = (search.get('dim') ?? 'firm') as Dimension;
  const start = search.get('start') ?? '';
  const end = search.get('end') ?? '';
  const drillUser = search.get('userId') ?? '';
  const drillEng = search.get('engagementId') ?? '';
  const drillClient = search.get('clientId') ?? '';
  const drillServiceLine = search.get('serviceLineId') ?? '';

  function setParam(name: string, value: string | null): void {
    const next = new URLSearchParams(search);
    if (value && value.length > 0) next.set(name, value);
    else next.delete(name);
    setSearch(next, { replace: false });
  }

  function clearDrill(): void {
    const next = new URLSearchParams(search);
    next.delete('userId');
    next.delete('engagementId');
    next.delete('clientId');
    next.delete('serviceLineId');
    setSearch(next, { replace: false });
  }

  const drillActive = Boolean(drillUser || drillEng || drillClient || drillServiceLine);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <FilterBar
        start={start}
        end={end}
        onStartChange={(v) => setParam('start', v)}
        onEndChange={(v) => setParam('end', v)}
        drillActive={drillActive}
        onClearDrill={clearDrill}
      />
      {/* id wrappers are the scroll targets for the Report-library cards.
          Revenue ops sits at the top, with Realization directly under it. */}
      <div id="revenue-ops-card">
        <RevenueOpsCard />
      </div>
      <div id="realization-card">
        <RealizationCard
          dim={dim}
          onDimChange={(d) => setParam('dim', d)}
          start={start}
          end={end}
          drillUser={drillUser}
          drillEng={drillEng}
          drillClient={drillClient}
          drillServiceLine={drillServiceLine}
          onDrill={(d, key) => {
            // Drill from a dimension row into the filtered firm summary.
            // (service_line rows used to be a dead click — the handler had
            // no branch for them, so the user just landed on the unfiltered
            // firm view.)
            const next = new URLSearchParams(search);
            if (d === 'timekeeper') next.set('userId', key);
            else if (d === 'engagement') next.set('engagementId', key);
            else if (d === 'client') next.set('clientId', key);
            else if (d === 'service_line') next.set('serviceLineId', key);
            next.set('dim', 'firm');
            setSearch(next);
          }}
        />
      </div>
      <div id="subscription-profitability-card">
        <SubscriptionProfitabilityCard />
      </div>
      <PlainEnglishCard />
      <ReportLibraryCards />
      <div id="billable-targets-card">
        <BillableTargetsCard />
      </div>
      <div id="capacity-forecast-card">
        <CapacityForecastCard />
      </div>
    </div>
  );
}

function FilterBar({
  start,
  end,
  onStartChange,
  onEndChange,
  drillActive,
  onClearDrill,
}: {
  start: string;
  end: string;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  drillActive: boolean;
  onClearDrill: () => void;
}): JSX.Element {
  function preset(days: number): void {
    onStartChange(new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10));
    onEndChange(today());
  }
  function clearDates(): void {
    onStartChange('');
    onEndChange('');
  }
  return (
    <Card title="Filters">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'end',
        }}
      >
        <Input
          label="Start"
          type="date"
          value={start}
          onChange={(e) => onStartChange(e.target.value)}
        />
        <Input label="End" type="date" value={end} onChange={(e) => onEndChange(e.target.value)} />
        <div style={{ display: 'flex', gap: 6, alignSelf: 'center' }}>
          <Button size="sm" variant="secondary" onClick={() => preset(7)}>
            7d
          </Button>
          <Button size="sm" variant="secondary" onClick={() => preset(30)}>
            30d
          </Button>
          <Button size="sm" variant="secondary" onClick={() => preset(90)}>
            90d
          </Button>
          <Button size="sm" variant="secondary" onClick={() => preset(365)}>
            12m
          </Button>
        </div>
        {(start || end) && (
          <Button size="sm" variant="secondary" onClick={clearDates}>
            Clear dates
          </Button>
        )}
        {drillActive && (
          <Button size="sm" onClick={onClearDrill}>
            ✕ Clear drill
          </Button>
        )}
        <span style={{ fontSize: 11, color: tokens.color.textMuted, marginLeft: 'auto' }}>
          Filters apply to realization by billed (invoice) date — the industry convention. Share
          this URL — settings persist via query string.
        </span>
      </div>
    </Card>
  );
}

function RealizationCard({
  dim,
  onDimChange,
  start,
  end,
  drillUser,
  drillEng,
  drillClient,
  drillServiceLine,
  onDrill,
}: {
  dim: Dimension;
  onDimChange: (d: Dimension) => void;
  start: string;
  end: string;
  drillUser: string;
  drillEng: string;
  drillClient: string;
  drillServiceLine: string;
  onDrill: (d: Exclude<Dimension, 'firm'>, key: string) => void;
}): JSX.Element {
  const [firmSummary, setFirmSummary] = useState<FirmSummary['summary'] | null>(null);
  const [items, setItems] = useState<DimensionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = useMemo(() => {
    const p = new URLSearchParams({ dimension: dim });
    if (start) p.set('start', start);
    if (end) p.set('end', end);
    if (drillUser) p.set('appUserId', drillUser);
    if (drillEng) p.set('engagementId', drillEng);
    if (drillClient) p.set('clientId', drillClient);
    if (drillServiceLine) p.set('serviceLineId', drillServiceLine);
    return `/api/staff/reports/realization?${p.toString()}`;
  }, [dim, start, end, drillUser, drillEng, drillClient, drillServiceLine]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (dim === 'firm') {
          const r = await api<FirmSummary>(url);
          setFirmSummary(r.summary);
          setItems([]);
        } else {
          const r = await api<DimResponse>(url);
          setItems(r.items ?? []);
          setFirmSummary(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [url, dim]);

  return (
    <Card
      title={`Realization${drillUser || drillEng || drillClient || drillServiceLine ? ' (drilled)' : ''}`}
      action={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {(['firm', 'timekeeper', 'engagement', 'client', 'service_line'] as const).map((d) => (
            <Button
              key={d}
              size="sm"
              variant={dim === d ? 'primary' : 'secondary'}
              onClick={() => onDimChange(d)}
            >
              {d === 'service_line' ? 'service line' : d}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            title="Download PDF"
            disabled={dim === 'firm' ? !firmSummary : items.length === 0}
            onClick={() =>
              void downloadReportPdf({
                title: 'Realization',
                subtitle: `${dim === 'service_line' ? 'Service line' : dim} · ${start} to ${end}`,
                columns: [
                  { label: dim === 'firm' ? 'Scope' : 'Name', align: 'left' },
                  { label: 'Original value', align: 'right' },
                  { label: 'Billed', align: 'right' },
                  { label: 'Realization %', align: 'right' },
                ],
                rows:
                  dim === 'firm' && firmSummary
                    ? [
                        [
                          'Firm',
                          formatCents(firmSummary.originalValueCents),
                          formatCents(firmSummary.adjustedValueCents),
                          `${(firmSummary.realizationPct * 100).toFixed(1)}%`,
                        ],
                      ]
                    : items.map((it) => [
                        it.label ?? it.key,
                        formatCents(it.originalValueCents),
                        formatCents(it.adjustedValueCents),
                        `${(it.realizationPct * 100).toFixed(1)}%`,
                      ]),
                totals:
                  dim !== 'firm' && items.length > 0
                    ? (() => {
                        const o = items.reduce((a, b) => a + b.originalValueCents, 0);
                        const v = items.reduce((a, b) => a + b.adjustedValueCents, 0);
                        return [
                          'Totals',
                          formatCents(o),
                          formatCents(v),
                          o > 0 ? `${((v / o) * 100).toFixed(1)}%` : '',
                        ];
                      })()
                    : undefined,
                totalsLabel: 'Totals',
              })
            }
          >
            ↓ PDF
          </Button>
          <a
            href={`${url}&format=csv`}
            download
            title="Download CSV"
            style={{
              padding: '4px 10px',
              fontSize: 13,
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.color.border}`,
              color: tokens.color.text,
              textDecoration: 'none',
            }}
          >
            ↓ CSV
          </a>
        </div>
      }
    >
      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      {loading ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      ) : dim === 'firm' ? (
        firmSummary ? (
          <div>
            <div style={{ display: 'flex', gap: 32 }}>
              <Stat
                label="Billed WIP (standard)"
                value={formatCents(firmSummary.originalValueCents)}
              />
              <Stat label="Amount billed" value={formatCents(firmSummary.adjustedValueCents)} />
              <Stat
                label="Realization"
                value={formatPct(firmSummary.realizationPct)}
                tone={firmSummary.realizationPct >= 0.9 ? 'success' : 'warning'}
              />
            </div>
            <NarrativeButton realizationPct={firmSummary.realizationPct} />
          </div>
        ) : (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>No adjustment data yet.</p>
        )
      ) : (
        <Table<DimensionItem>
          columns={[
            {
              key: 'label',
              header: dim.charAt(0).toUpperCase() + dim.slice(1),
              render: (r) =>
                // The unassigned service-line bucket is a sentinel, not a
                // UUID — it can't be drilled into.
                r.key === '__unassigned__' ? (
                  <span>{r.label ?? '(No service line)'}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onDrill(dim, r.key)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: tokens.color.accent,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 'inherit',
                      padding: 0,
                    }}
                    title={`Drill into ${dim} ${r.label ?? r.key.slice(0, 8)}`}
                  >
                    {r.label ?? r.key.slice(0, 8)}
                  </button>
                ),
            },
            {
              key: 'wip',
              header: 'Billed WIP (standard)',
              align: 'right',
              render: (r) => formatCents(r.originalValueCents),
            },
            {
              key: 'adj',
              header: 'Amount billed',
              align: 'right',
              render: (r) => formatCents(r.adjustedValueCents),
            },
            {
              key: 'pct',
              header: 'Realization',
              align: 'right',
              render: (r) => (
                <Pill tone={r.realizationPct >= 0.9 ? 'success' : 'warning'}>
                  {formatPct(r.realizationPct)}
                </Pill>
              ),
            },
          ]}
          rows={items}
          rowKey={(r) => r.key}
          empty="No data for this dimension yet."
        />
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
  trend,
  delta,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'warning';
  trend?: number[];
  delta?: { value: string; pct: number | null };
}): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div
          style={{
            fontSize: 22,
            fontWeight: 600,
            color:
              tone === 'success'
                ? tokens.color.success
                : tone === 'warning'
                  ? tokens.color.warning
                  : tokens.color.text,
          }}
        >
          {value}
        </div>
        {trend && trend.length > 1 && (
          <Sparkline
            values={trend}
            tone={tone === 'warning' ? 'warning' : tone === 'success' ? 'success' : 'accent'}
            ariaLabel={`${label} trend`}
          />
        )}
      </div>
      {delta && (
        <div
          style={{
            fontSize: 11,
            color:
              delta.pct == null
                ? tokens.color.textMuted
                : delta.pct >= 0
                  ? tokens.color.success
                  : tokens.color.danger,
            marginTop: 2,
          }}
          title="vs prior period"
        >
          {delta.pct == null
            ? `prior ${delta.value}`
            : `${delta.pct >= 0 ? '↑' : '↓'} ${Math.abs(delta.pct).toFixed(1)}% vs ${delta.value}`}
        </div>
      )}
    </div>
  );
}

interface DsoResp {
  windowDays: number;
  billedCents: number;
  paidCents: number;
  outstandingCents: number;
  dsoDays: number | null;
  collectionRatePct: number | null;
  prior?: {
    billedCents: number;
    paidCents: number;
    collectionRatePct: number | null;
    windowStart: string;
    windowEnd: string;
  };
}

interface SubProfitRow {
  planId: string;
  engagementName: string;
  clientName: string;
  frequency: string;
  monthlyRevenue: number;
  trailingRevenue: number;
  inScopeHours: number;
  oosHours: number;
  oosBilledCents: number;
  inScopeCostCents: number;
  grossMarginCents: number;
  grossMarginPct: number | null;
}
interface MrrResp {
  mrrCents: number;
  arrCents: number;
  planCount: number;
}

interface TargetRow {
  appUserId: string;
  fullName: string;
  billableHours: number;
  varianceHours: number;
  attainmentPct: number;
}

interface CapRow {
  appUserId: string;
  fullName: string;
  trailing90Hours: number;
  weeklyAvgHours: number;
  projectedNext4Weeks: number;
  varianceVsTarget: number;
}

function CapacityForecastCard(): JSX.Element {
  const [items, setItems] = useState<CapRow[]>([]);
  const [target, setTarget] = useState<number>(32);
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ weeklyTargetHours: number; items: CapRow[] }>(
          '/api/staff/reports/capacity-forecast',
        );
        setItems(r.items ?? []);
        setTarget(r.weeklyTargetHours);
      } catch {
        // ignore
      }
    })();
  }, []);
  if (items.length === 0) return <></>;
  return (
    <Card title={`Capacity forecast · next 4 weeks · weekly target ${target}h`}>
      <Table<CapRow>
        columns={[
          { key: 'name', header: 'Timekeeper', render: (r) => r.fullName },
          {
            key: 'avg',
            header: 'Weekly avg',
            align: 'right',
            render: (r) => r.weeklyAvgHours.toFixed(1),
          },
          {
            key: 'proj',
            header: 'Projected 4w',
            align: 'right',
            render: (r) => r.projectedNext4Weeks.toFixed(1),
          },
          {
            key: 'var',
            header: 'Variance',
            align: 'right',
            render: (r) => (
              <Pill
                tone={
                  r.varianceVsTarget >= 0
                    ? 'success'
                    : r.varianceVsTarget >= -16
                      ? 'warning'
                      : 'danger'
                }
              >
                {r.varianceVsTarget >= 0 ? '+' : ''}
                {r.varianceVsTarget.toFixed(0)}h
              </Pill>
            ),
          },
        ]}
        rows={items}
        rowKey={(r) => r.appUserId}
        empty="No projection data yet."
      />
    </Card>
  );
}

function BillableTargetsCard(): JSX.Element {
  const [items, setItems] = useState<TargetRow[]>([]);
  const [target, setTarget] = useState<number>(130);
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ targetHours: number; items: TargetRow[] }>(
          '/api/staff/reports/billable-targets',
        );
        setItems(r.items ?? []);
        setTarget(r.targetHours);
      } catch {
        // ignore
      }
    })();
  }, []);
  if (items.length === 0) return <></>;
  return (
    <Card title={`Billable-hour targets · current month · target ${target}h`}>
      <Table<TargetRow>
        columns={[
          { key: 'name', header: 'Timekeeper', render: (r) => r.fullName },
          {
            key: 'h',
            header: 'Hours',
            align: 'right',
            render: (r) => r.billableHours.toFixed(2),
          },
          {
            key: 'v',
            header: 'Variance',
            align: 'right',
            render: (r) =>
              r.varianceHours >= 0 ? `+${r.varianceHours.toFixed(1)}` : r.varianceHours.toFixed(1),
          },
          {
            key: 'att',
            header: 'Attainment',
            align: 'right',
            render: (r) => (
              <Pill
                tone={
                  r.attainmentPct >= 100 ? 'success' : r.attainmentPct >= 80 ? 'warning' : 'danger'
                }
              >
                {r.attainmentPct.toFixed(0)}%
              </Pill>
            ),
          },
        ]}
        rows={items}
        rowKey={(r) => r.appUserId}
        empty="No billable hours yet this month."
      />
    </Card>
  );
}

// Map a plain-English citation to a viewable report route. Match the AI's
// report label to a generic-viewer kind; otherwise just go to the Reports hub.
const VIEWER_BY_LABEL = new Map(VIEWER_REPORTS.map((r) => [r.label.toLowerCase(), r.kind]));
function citationHref(label: string): string {
  const kind = VIEWER_BY_LABEL.get(label.toLowerCase());
  return kind ? `/reports/view/${kind}` : '/reports';
}

function PlainEnglishCard(): JSX.Element {
  const [q, setQ] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [cites, setCites] = useState<Array<{ label: string; path: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function ask(): Promise<void> {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ answer: string; citations?: Array<{ label: string; path: string }> }>(
        '/api/staff/ai/plain-english-query',
        {
          method: 'POST',
          body: JSON.stringify({ question: q }),
        },
      );
      setText(r.answer);
      setCites(r.citations ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Ask in plain English">
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Ask any question about the practice; the AI suggests which reports to run.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask();
          }}
          placeholder='"Which engagements have the worst realization this quarter?"'
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.color.border}`,
            background: tokens.color.surface,
            color: tokens.color.text,
            fontSize: 13,
          }}
        />
        <Button onClick={() => void ask()} disabled={busy}>
          {busy ? '…' : '✨ Ask'}
        </Button>
      </div>
      {text && (
        <p
          style={{
            marginTop: 12,
            fontSize: 13,
            color: tokens.color.text,
            background: tokens.color.surface,
            padding: 12,
            borderRadius: tokens.radius.sm,
            whiteSpace: 'pre-wrap',
          }}
        >
          {text}
        </p>
      )}
      {cites.length > 0 && (
        <div
          style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}
        >
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Open report:</span>
          {cites.map((c) => (
            <a
              key={c.label}
              href={citationHref(c.label)}
              style={{
                fontSize: 12,
                padding: '3px 8px',
                borderRadius: tokens.radius.pill,
                border: `1px solid ${tokens.color.border}`,
                color: tokens.color.accent,
                textDecoration: 'none',
              }}
            >
              {c.label} →
            </a>
          ))}
        </div>
      )}
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
    </Card>
  );
}

function NarrativeButton({ realizationPct }: { realizationPct: number }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function ask(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ narrative: string }>('/api/staff/ai/realization-narrative', {
        method: 'POST',
        body: JSON.stringify({ realizationPct }),
      });
      setText(r.narrative);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ marginTop: 16 }}>
      <Button size="sm" variant="secondary" onClick={() => void ask()} disabled={busy}>
        {busy ? 'Asking AI…' : '✨ Explain this'}
      </Button>
      {text && (
        <p
          style={{
            marginTop: 8,
            fontSize: 13,
            color: tokens.color.text,
            background: tokens.color.surface,
            padding: 12,
            borderRadius: tokens.radius.sm,
            whiteSpace: 'pre-wrap',
          }}
        >
          {text}
        </p>
      )}
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
    </div>
  );
}

function RevenueOpsCard(): JSX.Element {
  const [dso, setDso] = useState<DsoResp | null>(null);
  const [mrr, setMrr] = useState<MrrResp | null>(null);
  const [trend, setTrend] = useState<PeriodRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  // MyBooks-style basis toggle for the monthly trend: accrual = billed/paid
  // by invoice issue month; cash = net collected by payment-receipt month.
  const [basis, setBasis] = useState<'accrual' | 'cash'>('accrual');

  useEffect(() => {
    void (async () => {
      try {
        const [d, m, p] = await Promise.all([
          api<DsoResp>('/api/staff/reports/dso?days=90'),
          api<MrrResp>('/api/staff/reports/mrr'),
          api<{ items: PeriodRow[] }>(
            `/api/staff/reports/revenue-period-over-period?basis=${basis}`,
          ),
        ]);
        setDso(d);
        setMrr(m);
        setTrend(p.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, [basis]);

  // Sparkline series — last 12 months. On cash basis both stats track the
  // collected series (there is no meaningful "billed" cash series).
  const billedTrend = trend
    .slice(-12)
    .map((r) => (basis === 'cash' ? (r.collectedCents ?? 0) : (r.billedCents ?? 0)));
  const paidTrend = trend
    .slice(-12)
    .map((r) => (basis === 'cash' ? (r.collectedCents ?? 0) : (r.paidCents ?? 0)));

  return (
    <Card
      title={`Revenue operations (last 90 days)${basis === 'cash' ? ' · cash trend' : ''}`}
      action={
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {(['accrual', 'cash'] as const).map((b) => (
            <Button
              key={b}
              size="sm"
              variant={basis === b ? 'primary' : 'secondary'}
              onClick={() => setBasis(b)}
            >
              {b === 'accrual' ? 'Accrual' : 'Cash'}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            title="Download this card's monthly trend as PDF"
            disabled={trend.length === 0}
            onClick={() =>
              void downloadReportPdf({
                title: 'Revenue by Month',
                subtitle:
                  basis === 'cash' ? 'Cash basis (collected)' : 'Accrual basis (billed + paid)',
                orientation: 'portrait',
                columns:
                  basis === 'cash'
                    ? [
                        { label: 'Month', align: 'left' },
                        { label: 'Collected', align: 'right' },
                        { label: 'Change %', align: 'right' },
                      ]
                    : [
                        { label: 'Month', align: 'left' },
                        { label: 'Billed', align: 'right' },
                        { label: 'Paid', align: 'right' },
                        { label: 'Change %', align: 'right' },
                      ],
                rows: trend.map((r) =>
                  basis === 'cash'
                    ? [
                        r.month,
                        formatCents(r.collectedCents ?? 0),
                        r.pctChangeCollected != null ? `${r.pctChangeCollected.toFixed(1)}%` : '',
                      ]
                    : [
                        r.month,
                        formatCents(r.billedCents ?? 0),
                        formatCents(r.paidCents ?? 0),
                        r.pctChangeBilled != null ? `${r.pctChangeBilled.toFixed(1)}%` : '',
                      ],
                ),
              })
            }
          >
            ↓ PDF
          </Button>
          <a
            href="/api/staff/invoices/export.csv?format=xlsx"
            title="Exports the invoice register, not this card"
            style={{
              fontSize: 12,
              color: tokens.color.accent,
              textDecoration: 'none',
            }}
          >
            ⬇ Invoices (Excel)
          </a>
        </span>
      }
    >
      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      {!dso && !mrr ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))',
            gap: 16,
          }}
        >
          {dso && (
            <>
              <Stat
                label="Billed"
                value={formatCents(dso.billedCents)}
                trend={billedTrend}
                delta={
                  dso.prior
                    ? {
                        value: formatCents(dso.prior.billedCents),
                        pct:
                          dso.prior.billedCents > 0
                            ? ((dso.billedCents - dso.prior.billedCents) / dso.prior.billedCents) *
                              100
                            : null,
                      }
                    : undefined
                }
              />
              <Stat
                label="Paid"
                value={formatCents(dso.paidCents)}
                trend={paidTrend}
                delta={
                  dso.prior
                    ? {
                        value: formatCents(dso.prior.paidCents),
                        pct:
                          dso.prior.paidCents > 0
                            ? ((dso.paidCents - dso.prior.paidCents) / dso.prior.paidCents) * 100
                            : null,
                      }
                    : undefined
                }
              />
              <Stat
                label="DSO"
                value={dso.dsoDays == null ? '—' : `${dso.dsoDays.toFixed(0)} d`}
                tone={dso.dsoDays != null && dso.dsoDays > 60 ? 'warning' : undefined}
              />
              <Stat
                label="Collection rate"
                value={dso.collectionRatePct == null ? '—' : formatPct(dso.collectionRatePct / 100)}
                tone={
                  dso.collectionRatePct != null && dso.collectionRatePct < 80
                    ? 'warning'
                    : undefined
                }
                delta={
                  dso.prior && dso.prior.collectionRatePct != null && dso.collectionRatePct != null
                    ? {
                        value: formatPct(dso.prior.collectionRatePct / 100),
                        pct: dso.collectionRatePct - dso.prior.collectionRatePct,
                      }
                    : undefined
                }
              />
            </>
          )}
          {mrr && (
            <Stat
              label={`MRR (${mrr.planCount} plans)`}
              value={formatCents(mrr.mrrCents)}
              tone="success"
            />
          )}
        </div>
      )}
    </Card>
  );
}

function SubscriptionProfitabilityCard(): JSX.Element {
  const [items, setItems] = useState<SubProfitRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: SubProfitRow[] }>(
          '/api/staff/reports/subscription-profitability',
        );
        setItems(r.items ?? []);
      } catch {
        // ignore — no subscription plans yet
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  if (loading) return <></>;
  if (items.length === 0) return <></>;
  return (
    <Card title="Subscription profitability (trailing 90 days)">
      <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: '0 0 8px' }}>
        Revenue = retainer (normalized to 90d) + out-of-scope billed. Cost = timekeeper cost-rate
        value of in-scope hours absorbed by the retainer. Sorted worst-margin first.
      </p>
      <Table<SubProfitRow>
        columns={[
          {
            key: 'eng',
            header: 'Engagement',
            render: (r) => `${r.engagementName} · ${r.clientName}`,
          },
          { key: 'freq', header: 'Cycle', render: (r) => r.frequency },
          {
            key: 'rev',
            header: 'Trailing rev',
            align: 'right',
            render: (r) => formatCents(r.trailingRevenue + r.oosBilledCents),
          },
          {
            key: 'inscope',
            header: 'In-scope hrs',
            align: 'right',
            render: (r) => r.inScopeHours.toFixed(1),
          },
          {
            key: 'oos',
            header: 'OOS hrs',
            align: 'right',
            render: (r) => r.oosHours.toFixed(1),
          },
          {
            key: 'margin',
            header: 'Margin',
            align: 'right',
            render: (r) => (
              <Pill
                tone={
                  r.grossMarginPct == null
                    ? 'neutral'
                    : r.grossMarginPct >= 0.5
                      ? 'success'
                      : r.grossMarginPct >= 0.25
                        ? 'warning'
                        : 'danger'
                }
              >
                {r.grossMarginPct == null ? '—' : `${(r.grossMarginPct * 100).toFixed(0)}%`}
              </Pill>
            ),
          },
        ]}
        rows={items}
        rowKey={(r) => r.planId}
        empty="No active recurring plans yet."
      />
    </Card>
  );
}

// Tame an unused-import warning when Reports.tsx is imported in tests.
void ninetyDaysAgo;

// =====================================================================
// ReportLibraryCards (v2 followup) — 10-card landing grid as the new
// header on /reports. Each card is a deep-link / inline view of a
// specific report kind so partners can navigate by intent.
// =====================================================================

interface CardSpec {
  key: string;
  title: string;
  blurb: string;
  href?: string;
  scrollTo?: string;
}

const REPORT_CARDS: CardSpec[] = [
  {
    key: 'payments-received',
    title: 'Payments received ★',
    blurb: 'Date range / office / method filter, sortable rows + CSV export.',
    href: '/reports/payments-received',
  },
  {
    key: 'signed-forms',
    title: 'Signed forms',
    blurb: 'Date range, sortable/searchable, with direct links to signed PDFs + certificates.',
    href: '/reports/signed-forms',
  },
  {
    key: 'billing-realization',
    title: 'Billing realization ★',
    blurb:
      'Hours · Amount · Adjusted · Fee · Charge rate · Fee rate · Real % by timekeeper, service line, engagement type, client, or engagement. CSV export.',
    href: '/reports/billing-realization',
  },
  {
    key: 'realization',
    title: 'Realization',
    blurb: 'Original vs adjusted value by firm / timekeeper / engagement / client.',
    scrollTo: 'realization-card',
  },
  {
    key: 'revenue-ops',
    title: 'Revenue ops',
    blurb: 'Billed + paid by month with period-over-period growth.',
    scrollTo: 'revenue-ops-card',
  },
  {
    key: 'profitability',
    title: 'Engagement profitability',
    blurb: 'Cost vs revenue by engagement, sortable.',
    href: '/reports/profitability',
  },
  {
    key: 'subscriptions',
    title: 'Subscription profitability',
    blurb: 'Per-plan retainer revenue vs cost-to-serve margin.',
    scrollTo: 'subscription-profitability-card',
  },
  {
    key: 'targets',
    title: 'Billable targets',
    blurb: 'Per-timekeeper progress vs firm target.',
    scrollTo: 'billable-targets-card',
  },
  {
    key: 'capacity',
    title: 'Capacity forecast',
    blurb: 'Projected billable hours vs target from the 90-day trailing average.',
    scrollTo: 'capacity-forecast-card',
  },
  {
    key: 'wip',
    title: 'WIP dashboard',
    blurb: 'Unbilled work, aged by submit date.',
    href: '/wip',
  },
  {
    key: 'ar',
    title: 'AR aging',
    blurb: 'Open invoices bucketed by age.',
    href: '/ar',
  },
  {
    key: 'ar-snapshot',
    title: 'AR snapshots',
    blurb: 'Daily AR snapshot history + diff between dates.',
    href: '/ar/snapshots',
  },
  {
    key: 'audit',
    title: 'Audit log',
    blurb: 'Every state change, append-only.',
    href: '/audit',
  },
  // Reports with no bespoke UI — opened in the generic viewer (table + CSV).
  ...VIEWER_REPORTS.map((r) => ({
    key: `view-${r.kind}`,
    title: r.label,
    blurb: r.description,
    href: `/reports/view/${r.kind}`,
  })),
];

function ReportLibraryCards(): JSX.Element {
  function go(c: CardSpec): void {
    if (c.href) {
      window.location.href = c.href;
      return;
    }
    if (c.scrollTo) {
      const el = document.getElementById(c.scrollTo);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  return (
    <Card title="Report library">
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Jump to a specific lens. Some cards scroll to a section below; others link to a dedicated
        page.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 10,
        }}
      >
        {REPORT_CARDS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => go(c)}
            style={{
              textAlign: 'left',
              padding: 12,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              background: tokens.color.surface,
              color: tokens.color.text,
              cursor: 'pointer',
              display: 'grid',
              gap: 4,
            }}
          >
            <strong style={{ fontSize: 13 }}>{c.title}</strong>
            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>{c.blurb}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}
