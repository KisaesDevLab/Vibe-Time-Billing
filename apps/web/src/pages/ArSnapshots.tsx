// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Row {
  asOfDate: string;
  totalCents: number;
  deltaFromPrevCents: number | null;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function ArSnapshotsPage(): JSX.Element {
  const [items, setItems] = useState<Row[]>([]);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: Row[] }>(`/api/staff/ar/snapshots/diff?days=${days}`);
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, [days]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 800 }}>
      <Card title="AR aging snapshot trend">
        <label style={{ fontSize: 13, display: 'block', marginBottom: 12 }}>
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
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
          </select>
        </label>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<Row>
          columns={[
            { key: 'date', header: 'As of', render: (r) => r.asOfDate },
            {
              key: 'tot',
              header: 'Total AR',
              align: 'right',
              render: (r) => formatCents(r.totalCents),
            },
            {
              key: 'd',
              header: 'Δ vs prior',
              align: 'right',
              render: (r) => {
                if (r.deltaFromPrevCents == null) return '—';
                const positive = r.deltaFromPrevCents > 0;
                return (
                  <Pill tone={positive ? 'warning' : 'success'}>
                    {positive ? '+' : ''}
                    {formatCents(r.deltaFromPrevCents)}
                  </Pill>
                );
              },
            },
          ]}
          rows={items}
          rowKey={(r) => r.asOfDate}
          empty="No snapshots in this window (worker hasn't run yet)."
        />
      </Card>
    </div>
  );
}
