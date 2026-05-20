// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string | null;
  totalCents: number;
  paidCents: number;
  status: string;
}

interface Totals {
  billedCents: number;
  paidCents: number;
  outstandingCents: number;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function StatementPage(): JSX.Element {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ invoices: InvoiceRow[]; totals: Totals | null }>(
          '/api/portal/profile/statement',
        );
        setInvoices(r.invoices ?? []);
        setTotals(r.totals);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      {totals && (
        <Card title="Account totals">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 16,
              fontSize: 13,
            }}
          >
            <Stat label="Billed (lifetime)" value={formatCents(totals.billedCents)} />
            <Stat label="Paid" value={formatCents(totals.paidCents)} />
            <Stat
              label="Outstanding"
              value={formatCents(totals.outstandingCents)}
              tone={totals.outstandingCents > 0 ? 'warning' : 'success'}
            />
          </div>
        </Card>
      )}
      <Card title="Invoice history">
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<InvoiceRow>
          columns={[
            {
              key: 'num',
              header: 'Invoice',
              render: (i) => <a href={`/invoices/${i.id}`}>{i.invoiceNumber}</a>,
            },
            { key: 'iss', header: 'Issued', render: (i) => i.issueDate },
            { key: 'due', header: 'Due', render: (i) => i.dueDate ?? '—' },
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
              render: (i) => (
                <Pill
                  tone={
                    i.status === 'PAID' ? 'success' : i.status === 'OVERDUE' ? 'danger' : 'neutral'
                  }
                >
                  {i.status}
                </Pill>
              ),
            },
          ]}
          rows={invoices}
          rowKey={(i) => i.id}
          empty="No invoices yet."
        />
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'warning';
}): JSX.Element {
  const color =
    tone === 'warning'
      ? tokens.color.warning
      : tone === 'success'
        ? tokens.color.success
        : tokens.color.text;
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}
