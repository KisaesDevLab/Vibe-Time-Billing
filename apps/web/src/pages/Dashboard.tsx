// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface RealizationItem {
  key: string;
  label: string | null;
  originalValueCents: number;
  adjustedValueCents: number;
  realizationPct: number;
}

interface FirmSummary {
  activeClients: number;
  activeEngagements: number;
  arOutstandingCents: number;
  collectionsLast30DaysCents: number;
  wipHours: number;
  wipAmountCents: number;
}

const formatPct = (p: number): string => `${(p * 100).toFixed(1)}%`;
const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function DashboardPage(): JSX.Element {
  const [items, setItems] = useState<RealizationItem[]>([]);
  const [summary, setSummary] = useState<FirmSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [r, s] = await Promise.all([
          api<{ items: RealizationItem[] }>('/api/staff/reports/realization?dimension=timekeeper'),
          api<{ summary: FirmSummary | null }>('/api/staff/stats/firm'),
        ]);
        setItems(r.items ?? []);
        setSummary(s.summary);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <AlertsCallout />
      {summary && (
        <Card title="Firm at a glance">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: 16,
            }}
          >
            <Stat label="Active clients" value={summary.activeClients.toLocaleString()} />
            <Stat label="Active engagements" value={summary.activeEngagements.toLocaleString()} />
            <Stat label="WIP" value={formatCents(summary.wipAmountCents)} />
            <Stat label="AR outstanding" value={formatCents(summary.arOutstandingCents)} />
            <Stat
              label="Collections (30d)"
              value={formatCents(summary.collectionsLast30DaysCents)}
            />
          </div>
        </Card>
      )}
      <Card title="Realization by timekeeper" action={<Pill tone="accent">live</Pill>}>
        {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table
            columns={[
              { key: 'name', header: 'Timekeeper', render: (r) => r.label ?? r.key },
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
                render: (r) => formatPct(r.realizationPct),
              },
            ]}
            rows={items}
            rowKey={(r) => r.key}
            empty="No adjustment data yet. Create a billing batch and a write-down to populate."
          />
        )}
      </Card>
      <Card title="What's next">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: tokens.color.textMuted }}>
          <li>Set up service lines and work codes under Admin → Taxonomy</li>
          <li>Invite staff and assign roles under Admin → Users</li>
          <li>Create clients and engagements</li>
          <li>Track time, then generate pre-bills and adjustments</li>
        </ul>
      </Card>
    </div>
  );
}

function AlertsCallout(): JSX.Element {
  const [count, setCount] = useState<number>(0);
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: unknown[] }>('/api/staff/audit/alerts');
        setCount(r.items.length);
      } catch {
        // ignore
      }
    })();
  }, []);
  if (count === 0) return <></>;
  return (
    <Card title="Alerts">
      <p style={{ fontSize: 13, margin: 0 }}>
        <Pill tone="warning">{count}</Pill>{' '}
        <a href="/alerts" style={{ color: tokens.color.accent }}>
          worker alerts need attention
        </a>{' '}
        — scope creep, aged WIP, audit anomalies, engagement rollovers.
      </p>
    </Card>
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
