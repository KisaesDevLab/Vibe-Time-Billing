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
            <div style={{ display: 'flex', gap: 32 }}>
              <Stat label="Standard WIP" value={formatCents(firmSummary.originalValueCents)} />
              <Stat label="After adjustments" value={formatCents(firmSummary.adjustedValueCents)} />
              <Stat
                label="Realization"
                value={formatPct(firmSummary.realizationPct)}
                tone={firmSummary.realizationPct >= 0.9 ? 'success' : 'warning'}
              />
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
