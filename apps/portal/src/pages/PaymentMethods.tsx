// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface PaymentMethodRow {
  id: string;
  kind: string;
  provider: string;
  lastFour: string | null;
  displayLabel: string | null;
  brand: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  status: string;
}

export function PaymentMethodsPage(): JSX.Element {
  const [items, setItems] = useState<PaymentMethodRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: PaymentMethodRow[] }>('/api/portal/profile/payment-methods');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function setAutopay(id: string): Promise<void> {
    setError(null);
    setStatus(null);
    try {
      await api(`/api/portal/profile/payment-methods/${id}/set-autopay`, { method: 'POST' });
      setStatus('Autopay updated.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Remove this payment method?')) return;
    setError(null);
    try {
      await api(`/api/portal/profile/payment-methods/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="Saved payment methods">
        {status && (
          <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>{status}</p>
        )}
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{error}</p>
        )}
        <Table<PaymentMethodRow>
          columns={[
            {
              key: 'label',
              header: 'Method',
              render: (p) => (
                <span>
                  {p.brand ?? p.kind}
                  {p.lastFour ? ` ····${p.lastFour}` : ''}
                  {p.displayLabel ? ` (${p.displayLabel})` : ''}
                </span>
              ),
            },
            {
              key: 'exp',
              header: 'Expires',
              render: (p) =>
                p.expMonth && p.expYear
                  ? `${String(p.expMonth).padStart(2, '0')}/${p.expYear}`
                  : '—',
            },
            {
              key: 'default',
              header: 'Autopay',
              render: (p) => (p.isDefault ? <Pill tone="success">default</Pill> : null),
            },
            {
              key: 'actions',
              header: '',
              render: (p) => (
                <span style={{ display: 'flex', gap: 6 }}>
                  {!p.isDefault && (
                    <Button size="sm" variant="secondary" onClick={() => void setAutopay(p.id)}>
                      Use for autopay
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => void remove(p.id)}>
                    Remove
                  </Button>
                </span>
              ),
            },
          ]}
          rows={items}
          rowKey={(p) => p.id}
          empty="No saved payment methods. Pay an invoice to save one."
        />
      </Card>
    </div>
  );
}
