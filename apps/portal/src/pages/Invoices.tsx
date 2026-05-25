// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Pill, Table, tokens, useIsNarrow } from '@vibe/ui';

import { api } from '../api-client';
import { InvoiceCardList } from '../components/InvoiceCardList';

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  status: 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOIDED';
}

interface LineItem {
  id: string;
  description: string;
  amountCents: number;
}

interface InvoiceDetail {
  invoice: InvoiceRow & {
    subtotalCents: number;
    feeCents: number;
    firstViewedAt: string | null;
    firmId: string;
  };
  lineItems: LineItem[];
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';
const statusTone = (s: string): Tone =>
  s === 'PAID'
    ? 'success'
    : s === 'OVERDUE'
      ? 'danger'
      : s === 'PARTIALLY_PAID'
        ? 'warning'
        : 'accent';

export function PortalInvoicesPage(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<InvoiceList />} />
      <Route path="/:id" element={<InvoiceDetailPage />} />
    </Routes>
  );
}

function InvoiceList(): JSX.Element {
  const [open, setOpen] = useState<InvoiceRow[]>([]);
  const [paid, setPaid] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const narrow = useIsNarrow();

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ open: InvoiceRow[]; paid: InvoiceRow[] }>('/api/portal/invoices');
        setOpen(r.open ?? []);
        setPaid(r.paid ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return <p style={{ color: tokens.color.textMuted }}>Loading…</p>;
  }
  if (error) {
    return <p style={{ color: tokens.color.danger }}>{error}</p>;
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900, margin: '0 auto' }}>
      <Card title={`Open invoices (${open.length})`}>
        {narrow ? (
          <InvoiceCardList
            rows={open}
            statusTone={statusTone}
            empty={
              <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No open invoices. Nice.</p>
            }
          />
        ) : (
          <Table<InvoiceRow>
            columns={[
              {
                key: 'num',
                header: 'Invoice',
                render: (i) => (
                  <Link to={`/invoices/${i.id}`} style={{ color: tokens.color.accent }}>
                    {i.invoiceNumber}
                  </Link>
                ),
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
                key: 'balance',
                header: 'Balance',
                align: 'right',
                render: (i) => formatCents(i.totalCents - i.paidCents),
              },
              {
                key: 'status',
                header: 'Status',
                render: (i) => <Pill tone={statusTone(i.status)}>{i.status}</Pill>,
              },
            ]}
            rows={open}
            rowKey={(i) => i.id}
            empty="No open invoices. Nice."
          />
        )}
      </Card>
      <Card title={`Paid (${paid.length})`}>
        {narrow ? (
          <InvoiceCardList
            rows={paid}
            statusTone={() => 'success'}
            empty={
              <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No paid invoices yet.</p>
            }
          />
        ) : (
          <Table<InvoiceRow>
            columns={[
              {
                key: 'num',
                header: 'Invoice',
                render: (i) => (
                  <Link to={`/invoices/${i.id}`} style={{ color: tokens.color.accent }}>
                    {i.invoiceNumber}
                  </Link>
                ),
              },
              { key: 'issue', header: 'Issued', render: (i) => i.issueDate },
              {
                key: 'total',
                header: 'Total',
                align: 'right',
                render: (i) => formatCents(i.totalCents),
              },
              {
                key: 'status',
                header: 'Status',
                render: (i) => <Pill tone="success">{i.status}</Pill>,
              },
            ]}
            rows={paid}
            rowKey={(i) => i.id}
            empty="No paid invoices yet."
          />
        )}
      </Card>
    </div>
  );
}

function InvoiceDetailPage(): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<InvoiceDetail>(`/api/portal/invoices/${id}`);
      setDetail(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function pay(): Promise<void> {
    setPaying(true);
    setError(null);
    try {
      await api(`/api/portal/invoices/${id}/pay`, { method: 'POST', body: '{}' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'payment failed');
    } finally {
      setPaying(false);
    }
  }

  if (loading || !detail) {
    return <p style={{ color: tokens.color.textMuted }}>Loading…</p>;
  }

  const inv = detail.invoice;
  const balance = inv.totalCents - inv.paidCents;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 760, margin: '0 auto' }}>
      <Card
        title={`Invoice ${inv.invoiceNumber}`}
        action={<Pill tone={statusTone(inv.status)}>{inv.status}</Pill>}
      >
        <div style={{ display: 'flex', gap: 32, fontSize: 13 }}>
          <div>
            <div
              style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}
            >
              Issued
            </div>
            <strong>{inv.issueDate}</strong>
          </div>
          <div>
            <div
              style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}
            >
              Due
            </div>
            <strong>{inv.dueDate}</strong>
          </div>
          <div>
            <div
              style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}
            >
              Total
            </div>
            <strong>{formatCents(inv.totalCents)}</strong>
          </div>
          <div>
            <div
              style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}
            >
              Balance
            </div>
            <strong style={{ color: balance > 0 ? tokens.color.warning : tokens.color.success }}>
              {formatCents(balance)}
            </strong>
          </div>
        </div>
      </Card>

      <Card title="Line items">
        <Table<LineItem>
          columns={[
            { key: 'desc', header: 'Description', render: (l) => l.description },
            {
              key: 'amt',
              header: 'Amount',
              align: 'right',
              render: (l) => formatCents(l.amountCents),
            },
          ]}
          rows={detail.lineItems}
          rowKey={(l) => l.id}
        />
      </Card>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="secondary" onClick={() => navigate('/invoices')}>
          Back
        </Button>
        <a
          href={`/api/portal/invoices/${inv.id}/pdf.html`}
          target="_blank"
          rel="noreferrer"
          style={{
            padding: '10px 16px',
            background: 'transparent',
            color: tokens.color.text,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            fontSize: 14,
            textDecoration: 'none',
            fontFamily: tokens.font.body,
          }}
        >
          View as PDF
        </a>
        {balance > 0 && (
          <Button onClick={() => void pay()} disabled={paying}>
            {paying ? 'Processing…' : `Pay ${formatCents(balance)}`}
          </Button>
        )}
      </div>
      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}
