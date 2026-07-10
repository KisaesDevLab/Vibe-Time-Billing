// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useMemo, useState } from 'react';

import { AiPanel, Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { aiUsable, useAiStatus } from '../../hooks/useAiStatus';

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

interface AiStatus {
  enabled: boolean;
  optedIn: boolean;
  providerWired: boolean;
  providerId: string | null;
}

export function AiUsagePage(): JSX.Element {
  const [items, setItems] = useState<LogRow[]>([]);
  const [days, setDays] = useState(30);
  const [feature, setFeature] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<AiStatus>('/api/staff/ai/status');
        setAiStatus(r);
      } catch {
        setAiStatus({ enabled: false, optedIn: false, providerWired: false, providerId: null });
      }
    })();
  }, []);

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
      <PricingRenewalCard />
      {aiStatus && (
        <Card title="AI status">
          <div style={{ display: 'flex', gap: 16, fontSize: 13, alignItems: 'center' }}>
            <span>
              Status:{' '}
              {aiStatus.enabled ? (
                <Pill tone="success">enabled</Pill>
              ) : (
                <Pill tone="warning">disabled</Pill>
              )}
            </span>
            <span>
              Opted in:{' '}
              {aiStatus.optedIn ? <Pill tone="success">yes</Pill> : <Pill tone="neutral">no</Pill>}
            </span>
            <span>
              Provider:{' '}
              {aiStatus.providerWired ? (
                <Pill tone="success">{aiStatus.providerId ?? 'wired'}</Pill>
              ) : (
                <Pill tone="warning">none</Pill>
              )}
            </span>
          </div>
          <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 8 }}>
            Toggle off via <code>VIBE_AI_DISABLED=true</code>. Per-feature overrides with{' '}
            <code>VIBE_AI_FEATURE_&lt;NAME&gt;=local|cloud</code>.
          </p>
        </Card>
      )}
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

// Phase 23 #27 — embedded pricing-renewal panel.
// Partner enters engagement type + service line, model returns a
// 3-line fee/effort/notes block. Lives on the AI Usage page so the
// firm-admin role lands on it during cost reviews.
function PricingRenewalCard(): JSX.Element | null {
  const ai = useAiStatus();
  const [engagementType, setEngagementType] = useState('');
  const [serviceLine, setServiceLine] = useState('');
  const [complexity, setComplexity] = useState<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  if (!aiUsable(ai)) return null;

  async function ask(): Promise<void> {
    if (!engagementType.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ text: string }>('/api/staff/ai/pricing-suggestion', {
        method: 'POST',
        body: JSON.stringify({
          engagementTypeName: engagementType,
          serviceLineName: serviceLine || undefined,
          complexity,
        }),
      });
      setText(r.text);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AiPanel
      title="Pricing renewal suggestions"
      providerId={ai?.providerId ?? undefined}
      busy={busy}
      error={err}
      action={
        <Button size="sm" onClick={() => void ask()} disabled={busy || !engagementType.trim()}>
          {text ? 'Regenerate' : 'Suggest'}
        </Button>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8 }}>
        <Input
          label="Engagement type"
          value={engagementType}
          onChange={(e) => setEngagementType(e.target.value)}
          placeholder="1040 individual return"
        />
        <Input
          label="Service line (optional)"
          value={serviceLine}
          onChange={(e) => setServiceLine(e.target.value)}
          placeholder="tax"
        />
        <label style={{ fontSize: 13 }}>
          Complexity
          <select
            value={complexity}
            onChange={(e) => setComplexity(e.target.value as 'LOW' | 'MEDIUM' | 'HIGH')}
            style={{
              marginTop: 4,
              padding: '6px 8px',
              background: tokens.color.surface,
              color: tokens.color.text,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              fontSize: 13,
            }}
          >
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
          </select>
        </label>
      </div>
      {text && (
        <pre
          style={{
            margin: 0,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            background: tokens.color.bg,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            padding: 8,
          }}
        >
          {text}
        </pre>
      )}
    </AiPanel>
  );
}
