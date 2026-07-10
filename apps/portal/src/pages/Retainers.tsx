// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// R6 — Portal retainer list + detail. Read-only client view of every
// active retainer + per-retainer ledger. Internal fields (staff name,
// description, app_user_id) are stripped server-side; this page just
// renders what comes back.

import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface RetainerRow {
  id: string;
  name: string;
  returnType: string;
  taxYear: number;
  tier: 'TIER_1' | 'TIER_2';
  hoursPurchased: string;
  hoursConsumed: string;
  expiryDate: string;
  status: 'active' | 'exhausted' | 'expired' | 'void';
  purchaseDate: string;
}

interface LedgerRow {
  id: string;
  kind: 'ACTIVATION' | 'CONSUME' | 'REVERSE';
  hoursDelta: string;
  hoursBalanceAfter: string;
  createdAt: string;
}

export function PortalRetainersPage(): JSX.Element {
  const [items, setItems] = useState<RetainerRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ retainer: RetainerRow; ledger: LedgerRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: RetainerRow[] }>('/api/portal/retainers');
        setItems(r.items ?? []);
        if ((r.items?.length ?? 0) > 0) setSelectedId(r.items![0]!.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load failed');
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void (async () => {
      try {
        const r = await api<{ retainer: RetainerRow; ledger: LedgerRow[] }>(
          `/api/portal/retainers/${selectedId}`,
        );
        setDetail(r);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load failed');
      }
    })();
  }, [selectedId]);

  if (items.length === 0) {
    return (
      <Card title="Your retainers">
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          You don&apos;t have any active retainers right now.
        </p>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <Card title="Your retainers">
        <Table<RetainerRow>
          columns={[
            { key: 'name', header: 'Coverage', render: (r) => r.name },
            { key: 'rt', header: 'Return', render: (r) => `${r.returnType} TY${r.taxYear}` },
            {
              key: 'hours',
              header: 'Hours remaining',
              render: (r) => {
                const remaining = Number(r.hoursPurchased) - Number(r.hoursConsumed);
                return `${remaining.toFixed(2)} / ${Number(r.hoursPurchased).toFixed(2)}`;
              },
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
                        : 'neutral'
                  }
                >
                  {r.status}
                </Pill>
              ),
            },
            {
              key: 'view',
              header: '',
              render: (r) => (
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: tokens.color.accent,
                    fontSize: 12,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  Activity
                </button>
              ),
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
        />
      </Card>

      {detail && (
        <Card title={`Activity — ${detail.retainer.name}`}>
          {detail.ledger.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No activity yet.</p>
          ) : (
            <Table<LedgerRow>
              columns={[
                {
                  key: 'date',
                  header: 'Date',
                  render: (r) => new Date(r.createdAt).toLocaleDateString(),
                },
                { key: 'kind', header: 'Type', render: (r) => r.kind },
                {
                  key: 'delta',
                  header: 'Hours',
                  render: (r) => Number(r.hoursDelta).toFixed(2),
                },
                {
                  key: 'bal',
                  header: 'Remaining',
                  render: (r) => Number(r.hoursBalanceAfter).toFixed(2),
                },
              ]}
              rows={detail.ledger}
              rowKey={(r) => r.id}
            />
          )}
        </Card>
      )}

      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}
