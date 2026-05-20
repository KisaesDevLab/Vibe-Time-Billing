// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Invoice {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  issueDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  status: 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOIDED';
  firstViewedAt: string | null;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const tone = (s: Invoice['status']) =>
  s === 'PAID'
    ? 'success'
    : s === 'OVERDUE'
      ? 'danger'
      : s === 'PARTIALLY_PAID'
        ? 'warning'
        : 'accent';

export function InvoicesPage(): JSX.Element {
  const [items, setItems] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ items: Invoice[] }>('/api/staff/invoices');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function send(id: string): Promise<void> {
    await api(`/api/staff/invoices/${id}/send`, { method: 'POST' });
    await load();
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card title="Invoices">
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<Invoice>
            columns={[
              { key: 'num', header: 'Invoice', render: (i) => i.invoiceNumber },
              { key: 'client', header: 'Client', render: (i) => i.clientName },
              { key: 'issue', header: 'Issued', render: (i) => i.issueDate },
              { key: 'due', header: 'Due', render: (i) => i.dueDate },
              {
                key: 'total',
                header: 'Total',
                align: 'right',
                render: (i) => formatCents(i.totalCents),
              },
              {
                key: 'paid',
                header: 'Paid',
                align: 'right',
                render: (i) => formatCents(i.paidCents),
              },
              {
                key: 'status',
                header: 'Status',
                render: (i) => <Pill tone={tone(i.status)}>{i.status}</Pill>,
              },
              {
                key: 'viewed',
                header: 'Viewed in portal',
                render: (i) =>
                  i.firstViewedAt ? (
                    <span style={{ color: tokens.color.success, fontSize: 12 }}>
                      {new Date(i.firstViewedAt).toLocaleDateString()}
                    </span>
                  ) : (
                    <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>not yet</span>
                  ),
              },
              {
                key: 'actions',
                header: '',
                render: (i) => (
                  <span style={{ display: 'flex', gap: 6 }}>
                    {i.status === 'DRAFT' && (
                      <Button size="sm" onClick={() => void send(i.id)}>
                        Send
                      </Button>
                    )}
                    <a
                      href={`/api/staff/invoices/${i.id}/pdf`}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        padding: '4px 10px',
                        fontSize: 12,
                        background: 'transparent',
                        color: tokens.color.text,
                        border: `1px solid ${tokens.color.border}`,
                        borderRadius: tokens.radius.sm,
                        textDecoration: 'none',
                      }}
                    >
                      PDF
                    </a>
                  </span>
                ),
              },
            ]}
            rows={items}
            rowKey={(i) => i.id}
            empty="No invoices yet. Finalize a billing batch first."
          />
        )}
      </Card>
    </div>
  );
}
