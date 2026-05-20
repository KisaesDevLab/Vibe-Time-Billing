// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useMemo, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface LogRow {
  id: string;
  occurredAt: string;
  feature: string;
  provider: string;
  model: string | null;
  requestTokens: number | null;
  responseTokens: number | null;
  costCents: number | null;
  success: boolean;
  latencyMs: number | null;
  errorMessage: string | null;
  appUserId: string | null;
}

const formatCents = (c: number): string => `$${(c / 100).toFixed(2)}`;

export function AiUsagePage(): JSX.Element {
  const [items, setItems] = useState<LogRow[]>([]);
  const [days, setDays] = useState(30);
  const [feature, setFeature] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const params = new URLSearchParams({ days: String(days) });
        if (feature) params.set('feature', feature);
        const r = await api<{ items: LogRow[] }>(`/api/staff/ai/request-log?${params.toString()}`);
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, [days, feature]);

  const totals = useMemo(() => {
    const sumCents = items.reduce((a, r) => a + (r.costCents ?? 0), 0);
    const sumIn = items.reduce((a, r) => a + (r.requestTokens ?? 0), 0);
    const sumOut = items.reduce((a, r) => a + (r.responseTokens ?? 0), 0);
    const failed = items.filter((r) => !r.success).length;
    return { sumCents, sumIn, sumOut, failed, count: items.length };
  }, [items]);

  const features = useMemo(() => {
    return Array.from(new Set(items.map((r) => r.feature))).sort();
  }, [items]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="AI usage summary">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 16,
            fontSize: 13,
          }}
        >
          <Stat label="Requests" value={String(totals.count)} />
          <Stat label="Failed" value={String(totals.failed)} />
          <Stat label="Input tok" value={totals.sumIn.toLocaleString()} />
          <Stat label="Output tok" value={totals.sumOut.toLocaleString()} />
          <Stat label="Cost" value={formatCents(totals.sumCents)} />
        </div>
        <div
          style={{
            display: 'flex',
            gap: 16,
            marginTop: 16,
            alignItems: 'center',
            fontSize: 13,
          }}
        >
          <label>
            Window:
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value, 10))}
              style={{
                marginLeft: 8,
                padding: '4px 8px',
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
              }}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 180 days</option>
            </select>
          </label>
          <label>
            Feature:
            <select
              value={feature}
              onChange={(e) => setFeature(e.target.value)}
              style={{
                marginLeft: 8,
                padding: '4px 8px',
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
              }}
            >
              <option value="">All</option>
              {features.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title={`Requests (${items.length})`}>
        <Table<LogRow>
          columns={[
            {
              key: 'when',
              header: 'When',
              render: (r) => new Date(r.occurredAt).toLocaleString(),
            },
            { key: 'feature', header: 'Feature', render: (r) => r.feature },
            { key: 'provider', header: 'Provider', render: (r) => r.provider },
            { key: 'model', header: 'Model', render: (r) => r.model ?? '—' },
            {
              key: 'tokens',
              header: 'Tokens (in/out)',
              align: 'right',
              render: (r) => `${r.requestTokens ?? 0} / ${r.responseTokens ?? 0}`,
            },
            {
              key: 'cost',
              header: 'Cost',
              align: 'right',
              render: (r) => formatCents(r.costCents ?? 0),
            },
            {
              key: 'lat',
              header: 'Latency',
              align: 'right',
              render: (r) => (r.latencyMs == null ? '—' : `${r.latencyMs}ms`),
            },
            {
              key: 'ok',
              header: 'Status',
              render: (r) =>
                r.success ? (
                  <Pill tone="success">ok</Pill>
                ) : (
                  <Pill tone="danger">{r.errorMessage?.slice(0, 30) ?? 'failed'}</Pill>
                ),
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No AI requests in this window."
        />
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
