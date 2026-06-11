// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useState } from 'react';

import { Card, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

type Bucket = '0-30' | '31-60' | '61-90' | '90+';

interface Row {
  id: string;
  name: string;
  buckets: Record<Bucket, number>;
  total: number;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function ArByServiceLinePage(): JSX.Element {
  const [items, setItems] = useState<Row[]>([]);
  const [asOf, setAsOf] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ asOf: string; items: Row[] }>('/api/staff/ar/aging/by-service-line');
        setAsOf(r.asOf);
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title={`AR aging by service line · ${asOf || 'loading'}`}>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<Row>
          columns={[
            { key: 'name', header: 'Service line', render: (r) => r.name },
            {
              key: 'b1',
              header: '0–30',
              align: 'right',
              render: (r) => formatCents(r.buckets['0-30']),
            },
            {
              key: 'b2',
              header: '31–60',
              align: 'right',
              render: (r) => formatCents(r.buckets['31-60']),
            },
            {
              key: 'b3',
              header: '61–90',
              align: 'right',
              render: (r) => formatCents(r.buckets['61-90']),
            },
            {
              key: 'b4',
              header: '90+',
              align: 'right',
              render: (r) => formatCents(r.buckets['90+']),
            },
            {
              key: 'total',
              header: 'Total',
              align: 'right',
              render: (r) => <strong>{formatCents(r.total)}</strong>,
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No outstanding AR by service line."
        />
      </Card>
    </div>
  );
}
