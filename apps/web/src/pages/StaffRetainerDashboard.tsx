// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R6-followup — Staff "/my/retainers" dashboard.
//
// Read-only view scoped to retainers on engagements where the signed-in
// user is partner_in_charge, manager, or has a row in
// engagement_assignment. No void / pause / resume actions — those live
// on the partner dashboard at /admin/retainers and require
// retainer:write.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface MyKpis {
  activeCount: number;
  hoursRemaining: number;
  nearExhaustion: number;
  expiring90d: number;
}

interface RetainerRow {
  id: string;
  clientId: string;
  engagementId: string;
  tier: 'TIER_1' | 'TIER_2';
  returnType: string;
  taxYear: number;
  name: string;
  hoursPurchased: string;
  hoursConsumed: string;
  expiryDate: string;
  status: 'active' | 'exhausted' | 'expired' | 'void' | 'paused';
  priceCents: number;
}

export function StaffRetainerDashboardPage(): JSX.Element {
  const [kpis, setKpis] = useState<MyKpis | null>(null);
  const [items, setItems] = useState<RetainerRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        const [k, list] = await Promise.all([
          api<{ kpis: MyKpis | null }>('/api/staff/retainers/mine/kpis'),
          api<{ items: RetainerRow[] }>('/api/staff/retainers/mine'),
        ]);
        setKpis(k.kpis);
        setItems(list.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load failed');
      }
    }
    void load();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 22 }}>My retainers</h1>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 4 }}>
          Retainers on engagements you are assigned to (partner, manager, or staff).
        </p>
      </header>

      <Card title="At a glance">
        {kpis ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
            }}
          >
            <Stat label="My active retainers" value={kpis.activeCount} />
            <Stat label="Hours remaining" value={kpis.hoursRemaining.toFixed(1)} />
            <Stat label="Near exhaustion (≤1h)" value={kpis.nearExhaustion} />
            <Stat label="Expiring in 90 days" value={kpis.expiring90d} />
          </div>
        ) : (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        )}
      </Card>

      <Card title="Retainers">
        {items.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            No retainers on engagements you are assigned to.
          </p>
        ) : (
          <Table<RetainerRow>
            columns={[
              {
                key: 'name',
                header: 'Name',
                render: (r) => (
                  <Link to={`/admin/retainers/${r.id}`} style={{ color: tokens.color.accent }}>
                    {r.name}
                  </Link>
                ),
              },
              { key: 'rt', header: 'Type', render: (r) => `${r.returnType} (${r.tier})` },
              {
                key: 'hours',
                header: 'Hours used / purchased',
                render: (r) => (
                  <HoursBar
                    consumed={Number(r.hoursConsumed)}
                    purchased={Number(r.hoursPurchased)}
                  />
                ),
              },
              {
                key: 'expires',
                header: 'Expires',
                render: (r) => new Date(r.expiryDate).toLocaleDateString(),
              },
              {
                key: 'status',
                header: 'Status',
                render: (r) => (
                  <Pill
                    tone={
                      r.status === 'active'
                        ? 'success'
                        : r.status === 'exhausted'
                          ? 'warning'
                          : r.status === 'paused'
                            ? 'accent'
                            : r.status === 'expired'
                              ? 'neutral'
                              : 'danger'
                    }
                  >
                    {r.status}
                  </Pill>
                ),
              },
            ]}
            rows={items}
            rowKey={(r) => r.id}
          />
        )}
      </Card>

      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div
      style={{
        padding: 12,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.surface,
      }}
    >
      <div style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function HoursBar({ consumed, purchased }: { consumed: number; purchased: number }): JSX.Element {
  const pct = purchased > 0 ? Math.min(100, Math.round((consumed / purchased) * 100)) : 0;
  const tone =
    pct >= 90 ? tokens.color.danger : pct >= 60 ? tokens.color.warning : tokens.color.success;
  return (
    <div style={{ display: 'grid', gap: 4, minWidth: 180 }}>
      <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
        {consumed.toFixed(2)} / {purchased.toFixed(2)}
      </div>
      <div
        style={{
          width: '100%',
          height: 6,
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: tone }} />
      </div>
    </div>
  );
}
