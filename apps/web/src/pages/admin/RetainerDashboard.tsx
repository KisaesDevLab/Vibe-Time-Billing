// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R5 — Partner retainer dashboard. KPI strip + retainer table.
// Tier-config + firm-settings live at /admin/retainer-tiers; this page
// is the operational view.

import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Kpis {
  activeCount: number;
  tier1Active: number;
  tier2Active: number;
  hoursSold12mo: number;
  hoursConsumed12mo: number;
  expiring90d: number;
  openOffers: number;
  purchased90d: number;
  declined90d: number;
  expired90d: number;
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
  status: 'active' | 'exhausted' | 'expired' | 'void';
  priceCents: number;
}

export function RetainerDashboardPage(): JSX.Element {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [items, setItems] = useState<RetainerRow[]>([]);
  const [voidId, setVoidId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [k, list] = await Promise.all([
        api<{ kpis: Kpis | null }>('/api/staff/retainers/admin/kpis'),
        api<{ items: RetainerRow[] }>('/api/staff/retainers'),
      ]);
      setKpis(k.kpis);
      setItems(list.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function performVoid(): Promise<void> {
    if (!voidId) return;
    setError(null);
    try {
      await api(`/api/staff/retainers/${voidId}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: voidReason }),
      });
      setVoidId(null);
      setVoidReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'void failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Retainer KPIs">
        {kpis ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 12,
            }}
          >
            <Stat label="Active" value={kpis.activeCount} />
            <Stat label="Tier 1 active" value={kpis.tier1Active} />
            <Stat label="Tier 2 active" value={kpis.tier2Active} />
            <Stat label="Hours sold (12mo)" value={kpis.hoursSold12mo.toFixed(1)} />
            <Stat label="Hours consumed (12mo)" value={kpis.hoursConsumed12mo.toFixed(1)} />
            <Stat
              label="Utilization"
              value={
                kpis.hoursSold12mo > 0
                  ? `${Math.round((kpis.hoursConsumed12mo / kpis.hoursSold12mo) * 100)}%`
                  : '—'
              }
            />
            <Stat label="Expiring 90d" value={kpis.expiring90d} />
            <Stat label="Open offers" value={kpis.openOffers} />
            <Stat label="Purchased 90d" value={kpis.purchased90d} />
            <Stat label="Declined 90d" value={kpis.declined90d} />
            <Stat label="Expired 90d" value={kpis.expired90d} />
          </div>
        ) : (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        )}
      </Card>

      <Card title="Retainers">
        {items.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No retainers yet.</p>
        ) : (
          <Table<RetainerRow>
            columns={[
              { key: 'name', header: 'Name', render: (r) => r.name },
              { key: 'rt', header: 'Type', render: (r) => `${r.returnType} (${r.tier})` },
              {
                key: 'hours',
                header: 'Hours',
                render: (r) =>
                  `${Number(r.hoursConsumed).toFixed(2)} / ${Number(r.hoursPurchased).toFixed(2)}`,
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
                          : r.status === 'expired'
                            ? 'neutral'
                            : 'danger'
                    }
                  >
                    {r.status}
                  </Pill>
                ),
              },
              {
                key: 'actions',
                header: '',
                render: (r) =>
                  Number(r.hoursConsumed) === 0 && r.status !== 'void' ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setVoidId(r.id)}>
                      Void
                    </Button>
                  ) : null,
              },
            ]}
            rows={items}
            rowKey={(r) => r.id}
          />
        )}
      </Card>

      {voidId && (
        <Card title="Void retainer">
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            Voiding clears the retainer and lets a new offer be issued against this engagement.
            Allowed only when no hours have been consumed (D24).
          </p>
          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            Reason
            <textarea
              rows={3}
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              style={{
                padding: 8,
                fontSize: 13,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Button type="button" onClick={performVoid} disabled={voidReason.length === 0}>
              Confirm void
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setVoidId(null);
                setVoidReason('');
              }}
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}

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
