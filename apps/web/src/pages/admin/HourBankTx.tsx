// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Bank {
  id: string;
  engagementName: string;
  clientName: string;
}

interface Tx {
  id: string;
  hourBankId: string;
  kind: string;
  hours: string;
  amountCents: number;
  runningBalanceHours: string;
  description: string | null;
  occurredAt: string;
}

const formatCents = (c: number): string => `$${(c / 100).toFixed(2)}`;

export function HourBankTxPage(): JSX.Element {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [items, setItems] = useState<Tx[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: Bank[] }>('/api/staff/hour-banks');
        setBanks(r.items ?? []);
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    if (!selected) {
      setItems([]);
      return;
    }
    void (async () => {
      try {
        const r = await api<{ items: Tx[] }>(`/api/staff/hour-banks/${selected}/transactions`);
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, [selected]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Hour-bank transactions">
        <label style={{ fontSize: 13, display: 'block', marginBottom: 12 }}>
          Hour bank:
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{
              marginLeft: 8,
              padding: '4px 8px',
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.color.border}`,
              minWidth: 360,
            }}
          >
            <option value="">— Pick a bank —</option>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.clientName} · {b.engagementName}
              </option>
            ))}
          </select>
        </label>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        {selected && (
          <Table<Tx>
            columns={[
              {
                key: 'when',
                header: 'When',
                render: (t) => new Date(t.occurredAt).toLocaleString(),
              },
              {
                key: 'kind',
                header: 'Kind',
                render: (t) => (
                  <Pill
                    tone={
                      t.kind === 'CREDIT'
                        ? 'success'
                        : t.kind === 'FORFEIT'
                          ? 'danger'
                          : t.kind === 'REFUND'
                            ? 'warning'
                            : 'neutral'
                    }
                  >
                    {t.kind}
                  </Pill>
                ),
              },
              { key: 'h', header: 'Hours', align: 'right', render: (t) => t.hours },
              {
                key: 'a',
                header: 'Amount',
                align: 'right',
                render: (t) => formatCents(t.amountCents),
              },
              {
                key: 'bal',
                header: 'Running',
                align: 'right',
                render: (t) => t.runningBalanceHours,
              },
              { key: 'desc', header: 'Note', render: (t) => t.description ?? '' },
            ]}
            rows={items}
            rowKey={(t) => t.id}
            empty="No transactions on this bank."
          />
        )}
      </Card>
    </div>
  );
}
