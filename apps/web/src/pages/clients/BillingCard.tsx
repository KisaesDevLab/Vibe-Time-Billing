// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client billing tab (v2 followup). Lists invoices scoped to this
// client. Uses the existing /api/staff/invoices?clientId=... endpoint.

import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Invoice {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  primaryEngagementId: string | null;
}

interface Props {
  clientId: string;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function BillingCard({ clientId }: Props): JSX.Element {
  const [items, setItems] = useState<Invoice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: Invoice[] }>(
          `/api/staff/invoices?clientId=${encodeURIComponent(clientId)}`,
        );
        setItems(r.items ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'load_failed');
      }
    })();
  }, [clientId]);

  const totals = items.reduce(
    (acc, i) => ({
      invoiced: acc.invoiced + i.totalCents,
      paid: acc.paid + i.paidCents,
      balance: acc.balance + (i.totalCents - i.paidCents),
    }),
    { invoiced: 0, paid: 0, balance: 0 },
  );

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <Card title="Billing summary">
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <Stat label="Invoiced" value={formatCents(totals.invoiced)} />
          <Stat label="Paid" value={formatCents(totals.paid)} />
          <Stat label="Outstanding" value={formatCents(totals.balance)} />
        </div>
      </Card>

      <Card title={`Invoices (${items.length})`}>
        <Table<Invoice>
          columns={[
            {
              key: 'num',
              header: 'Number',
              render: (i) => <a href={`/invoices?focus=${i.id}`}>{i.invoiceNumber}</a>,
            },
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
              key: 'bal',
              header: 'Balance',
              align: 'right',
              render: (i) => formatCents(i.totalCents - i.paidCents),
            },
            {
              key: 'status',
              header: 'Status',
              render: (i) => (
                <Pill
                  tone={
                    i.status === 'PAID'
                      ? 'success'
                      : i.status === 'OVERDUE'
                        ? 'danger'
                        : i.status === 'VOIDED'
                          ? 'neutral'
                          : 'accent'
                  }
                >
                  {i.status}
                </Pill>
              ),
            },
          ]}
          rows={items}
          rowKey={(i) => i.id}
          empty="No invoices issued yet for this client."
        />
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
