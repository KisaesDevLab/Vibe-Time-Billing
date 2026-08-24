// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client statement: lifetime account totals (outstanding always visible),
// plus an A/R ledger over a changeable date range (defaults to year to
// date). Invoice rows open the invoice view; payment rows open the
// payment receipt PDF. Running balance is computed server-side over the
// full history, so rows are accurate regardless of the window.

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface LedgerRow {
  date: string;
  type: 'INVOICE' | 'PAYMENT' | 'REFUND';
  reference: string;
  description: string;
  chargeCents: number;
  creditCents: number;
  balanceCents: number;
  invoiceId: string;
  paymentId: string | null;
}

interface Totals {
  billedCents: number;
  paidCents: number;
  outstandingCents: number;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function yearToDate(): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

const TYPE_TONE: Record<LedgerRow['type'], 'neutral' | 'success' | 'danger'> = {
  INVOICE: 'neutral',
  PAYMENT: 'success',
  REFUND: 'danger',
};

export function StatementPage(): JSX.Element {
  const ytd = yearToDate();
  const [from, setFrom] = useState(ytd.from);
  const [to, setTo] = useState(ytd.to);
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: string, t: string) => {
    try {
      const r = await api<{ ledger: LedgerRow[]; totals: Totals | null }>(
        `/api/portal/profile/statement?from=${f}&to=${t}`,
      );
      setLedger(r.ledger ?? []);
      setTotals(r.totals);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
      setLedger([]);
    }
  }, []);

  useEffect(() => {
    void load(from, to);
    // Refetch only on explicit range changes.
  }, [load, from, to]);

  const isYtd = from === ytd.from && to === ytd.to;

  const dateInput: React.CSSProperties = {
    padding: '5px 8px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.surface,
    color: tokens.color.text,
  };

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      {totals && (
        <Card title="Account totals">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 16,
              fontSize: 13,
            }}
          >
            <Stat label="Billed (lifetime)" value={formatCents(totals.billedCents)} />
            <Stat label="Paid" value={formatCents(totals.paidCents)} />
            <Stat
              label="Outstanding balance"
              value={formatCents(totals.outstandingCents)}
              tone={totals.outstandingCents > 0 ? 'warning' : 'success'}
            />
          </div>
        </Card>
      )}

      <Card
        title="Account activity"
        action={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
              aria-label="Activity from date"
              style={dateInput}
            />
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>to</span>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => e.target.value && setTo(e.target.value)}
              aria-label="Activity to date"
              style={dateInput}
            />
            {!isYtd && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const r = yearToDate();
                  setFrom(r.from);
                  setTo(r.to);
                }}
              >
                Year to date
              </Button>
            )}
          </span>
        }
      >
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
            {error}
          </p>
        )}
        {ledger == null ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
        ) : (
          <Table<LedgerRow>
            columns={[
              { key: 'date', header: 'Date', render: (r) => r.date },
              {
                key: 'type',
                header: 'Type',
                render: (r) => <Pill tone={TYPE_TONE[r.type]}>{r.type}</Pill>,
              },
              {
                key: 'desc',
                header: 'Activity',
                render: (r) =>
                  r.type === 'INVOICE' ? (
                    <a href={`/invoices/${r.invoiceId}`}>{r.description}</a>
                  ) : (
                    r.description
                  ),
              },
              {
                key: 'charge',
                header: 'Charges',
                align: 'right',
                render: (r) => (r.chargeCents ? formatCents(r.chargeCents) : ''),
              },
              {
                key: 'credit',
                header: 'Payments',
                align: 'right',
                render: (r) => (r.creditCents ? formatCents(r.creditCents) : ''),
              },
              {
                key: 'balance',
                header: 'Balance',
                align: 'right',
                render: (r) => formatCents(r.balanceCents),
              },
              {
                key: 'doc',
                header: '',
                render: (r) =>
                  r.type === 'PAYMENT' && r.paymentId ? (
                    <a
                      href={`/api/portal/invoices/${r.invoiceId}/payments/${r.paymentId}/receipt`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Receipt
                    </a>
                  ) : r.type === 'INVOICE' ? (
                    <a href={`/invoices/${r.invoiceId}`}>View</a>
                  ) : null,
              },
            ]}
            rows={ledger}
            rowKey={(r) => `${r.type}-${r.invoiceId}-${r.paymentId ?? r.date}`}
            empty="No activity in this date range."
          />
        )}
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
