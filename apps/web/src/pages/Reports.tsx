// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

type Dimension = 'firm' | 'timekeeper' | 'engagement' | 'client';

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

const formatPct = (p: number): string => `${(p * 100).toFixed(1)}%`;
const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function ReportsPage(): JSX.Element {
  const [dim, setDim] = useState<Dimension>('firm');
  const [firmSummary, setFirmSummary] = useState<FirmSummary['summary'] | null>(null);
  const [items, setItems] = useState<DimensionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (dim === 'firm') {
          const r = await api<FirmSummary>('/api/staff/reports/realization?dimension=firm');
          setFirmSummary(r.summary);
          setItems([]);
        } else {
          const r = await api<DimResponse>(`/api/staff/reports/realization?dimension=${dim}`);
          setItems(r.items ?? []);
          setFirmSummary(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [dim]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <RevenueOpsCard />
      <PlainEnglishCard />
      <BillableTargetsCard />
      <CapacityForecastCard />
      <Card
        title="Realization"
        action={
          <div style={{ display: 'flex', gap: 6 }}>
            {(['firm', 'timekeeper', 'engagement', 'client'] as const).map((d) => (
              <Button
                key={d}
                size="sm"
                variant={dim === d ? 'primary' : 'secondary'}
                onClick={() => setDim(d)}
              >
                {d}
              </Button>
            ))}
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
                <Stat label="Standard WIP" value={formatCents(firmSummary.originalValueCents)} />
                <Stat
                  label="After adjustments"
                  value={formatCents(firmSummary.adjustedValueCents)}
                />
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
                render: (r) => r.label ?? <code>{r.key.slice(0, 8)}</code>,
              },
              {
                key: 'wip',
                header: 'Standard WIP',
                align: 'right',
                render: (r) => formatCents(r.originalValueCents),
              },
              {
                key: 'adj',
                header: 'After adjustments',
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
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'warning';
}): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}>
        {label}
      </div>
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

function PlainEnglishCard(): JSX.Element {
  const [q, setQ] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function ask(): Promise<void> {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ answer: string }>('/api/staff/ai/plain-english-query', {
        method: 'POST',
        body: JSON.stringify({ question: q }),
      });
      setText(r.answer);
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [d, m] = await Promise.all([
          api<DsoResp>('/api/staff/reports/dso?days=90'),
          api<MrrResp>('/api/staff/reports/mrr'),
        ]);
        setDso(d);
        setMrr(m);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, []);

  return (
    <Card title="Revenue operations (last 90 days)">
      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      {!dso && !mrr ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>
          {dso && (
            <>
              <Stat label="Billed" value={formatCents(dso.billedCents)} />
              <Stat label="Paid" value={formatCents(dso.paidCents)} />
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
