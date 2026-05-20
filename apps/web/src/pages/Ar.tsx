// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

type Bucket = '0-30' | '31-60' | '61-90' | '90+';

interface ClientAging {
  clientId: string;
  clientName: string;
  buckets: Record<Bucket, number>;
  total: number;
}

interface ArResponse {
  asOf: string;
  totals: Record<Bucket, number>;
  clients: ClientAging[];
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const buckets: Bucket[] = ['0-30', '31-60', '61-90', '90+'];

export function ArPage(): JSX.Element {
  const [data, setData] = useState<ArResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<ArResponse>('/api/staff/ar/aging');
        setData(r);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <p style={{ color: tokens.color.textMuted }}>Loading…</p>;
  if (error || !data) return <p style={{ color: tokens.color.danger }}>{error}</p>;

  const grand =
    data.totals['0-30'] + data.totals['31-60'] + data.totals['61-90'] + data.totals['90+'];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title={`AR aging as of ${data.asOf}`} action={<Pill tone="accent">live</Pill>}>
        <div style={{ display: 'flex', gap: 32, fontSize: 13 }}>
          {buckets.map((b) => (
            <div key={b}>
              <div
                style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}
              >
                {b} days
              </div>
              <strong
                style={{
                  fontSize: 18,
                  color: b === '90+' ? tokens.color.danger : tokens.color.text,
                }}
              >
                {formatCents(data.totals[b])}
              </strong>
            </div>
          ))}
          <div>
            <div
              style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}
            >
              Total
            </div>
            <strong style={{ fontSize: 18 }}>{formatCents(grand)}</strong>
          </div>
        </div>
      </Card>
      <Card title="By client">
        <Table<ClientAging>
          columns={[
            { key: 'name', header: 'Client', render: (c) => c.clientName },
            ...buckets.map((b) => ({
              key: b,
              header: b,
              align: 'right' as const,
              render: (c: ClientAging) => formatCents(c.buckets[b]),
            })),
            {
              key: 'total',
              header: 'Total',
              align: 'right',
              render: (c) => <strong>{formatCents(c.total)}</strong>,
            },
          ]}
          rows={data.clients}
          rowKey={(c) => c.clientId}
          empty="No outstanding AR. Beautiful."
        />
      </Card>
    </div>
  );
}
