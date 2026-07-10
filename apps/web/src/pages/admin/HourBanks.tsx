// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Bank {
  id: string;
  engagementId: string;
  engagementName: string;
  clientName: string;
  openingHours: string;
  openingAmountCents: number;
  expirationDate: string | null;
  forfeitedAt: string | null;
}

export function HourBanksPage(): JSX.Element {
  const [items, setItems] = useState<Bank[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: Bank[] }>('/api/staff/hour-banks');
        setItems(r.items ?? []);
      } catch {
        // ignore
      }
    })();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <Card title="Hour banks">
        <Table<Bank>
          columns={[
            { key: 'client', header: 'Client', render: (b) => b.clientName },
            { key: 'eng', header: 'Engagement', render: (b) => b.engagementName },
            { key: 'opening-h', header: 'Opening hours', render: (b) => b.openingHours },
            {
              key: 'opening-a',
              header: 'Opening amount',
              render: (b) => `$${(b.openingAmountCents / 100).toFixed(2)}`,
            },
            { key: 'exp', header: 'Expires', render: (b) => b.expirationDate ?? '—' },
            {
              key: 'status',
              header: 'Status',
              render: (b) =>
                b.forfeitedAt ? (
                  <Pill tone="warning">FORFEITED</Pill>
                ) : (
                  <Pill tone="accent">ACTIVE</Pill>
                ),
            },
          ]}
          rows={items}
          rowKey={(b) => b.id}
          empty="No hour banks yet."
        />
      </Card>
    </div>
  );
}
