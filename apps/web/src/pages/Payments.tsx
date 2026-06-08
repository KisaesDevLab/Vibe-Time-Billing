// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Billing → Payments. Payment-grain listing of received payments with a derived
// channel, status, fees, net, and drill-through to the invoice. Read-only;
// refunds happen on the invoice. Defaults to the current month. Backed by
// GET /api/staff/payments/received. A receipt-grain CSV report lives under
// Reports → Payments Received.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, Pill, SectionHeading, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Row {
  paymentId: string;
  receivedAt: string;
  clientId: string;
  clientName: string;
  invoiceId: string;
  invoiceNumber: string;
  amountCents: number;
  feeCents: number;
  netCents: number;
  provider: string;
  status: string;
  refundedAmountCents: number;
  channel: string;
}
interface Summary {
  count: number;
  grossCents: number;
  feesCents: number;
  netCents: number;
  refundsCents: number;
  pendingCount: number;
}

function dollars(c: number): string {
  return (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  SUCCEEDED: 'success',
  PENDING: 'warning',
  FAILED: 'danger',
  REFUNDED: 'neutral',
  PARTIALLY_REFUNDED: 'neutral',
};

type SortKey = 'date' | 'client' | 'amount' | 'status';

export function PaymentsPage(): JSX.Element {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('date');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ start: from, end: to });
      if (status) qs.set('status', status);
      if (channel) qs.set('channel', channel);
      if (q.trim()) qs.set('q', q.trim());
      const r = await api<{ items: Row[]; summary: Summary }>(
        `/api/staff/payments/received?${qs.toString()}`,
      );
      setRows(r.items);
      setSummary(r.summary);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }, [from, to, status, channel, q]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, status, channel]);

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'client':
          cmp = a.clientName.localeCompare(b.clientName);
          break;
        case 'amount':
          cmp = a.amountCents - b.amountCents;
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
        default:
          cmp = a.receivedAt.localeCompare(b.receivedAt);
      }
      return dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [rows, sortBy, dir]);

  function sortHeader(label: string, key: SortKey): JSX.Element {
    const activeCol = sortBy === key;
    return (
      <button
        type="button"
        onClick={() => {
          if (activeCol) setDir(dir === 'asc' ? 'desc' : 'asc');
          else {
            setSortBy(key);
            setDir('desc');
          }
        }}
        style={{
          background: 'none',
          border: 0,
          cursor: 'pointer',
          font: 'inherit',
          color: 'inherit',
          padding: 0,
          fontWeight: 600,
        }}
      >
        {label}
        {activeCol ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    );
  }

  function exportCsv(): void {
    const head = [
      'Date',
      'Client',
      'Invoice',
      'Channel',
      'Provider',
      'Amount',
      'Fee',
      'Net',
      'Status',
      'Refunded',
    ];
    const lines = [head.join(',')];
    for (const r of sorted) {
      lines.push(
        [
          r.receivedAt.slice(0, 10),
          `"${r.clientName.replace(/"/g, '""')}"`,
          r.invoiceNumber,
          r.channel,
          r.provider,
          (r.amountCents / 100).toFixed(2),
          (r.feeCents / 100).toFixed(2),
          (r.netCents / 100).toFixed(2),
          r.status,
          (r.refundedAmountCents / 100).toFixed(2),
        ].join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `payments-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const inputStyle: React.CSSProperties = {
    padding: '6px 8px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
  };

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1400, alignContent: 'start' }}>
      <SectionHeading
        title="Payments"
        description="Payments received — card, ACH, in-person, and manually recorded. Refunds are handled on the invoice."
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={exportCsv} disabled={rows.length === 0}>
              ⤓ CSV
            </Button>
            <Link to="/reports/payments-received">
              <Button size="sm" variant="ghost">
                Full report ↗
              </Button>
            </Link>
          </div>
        }
      />

      {summary && (
        <Card>
          <div style={{ display: 'flex', gap: 36, flexWrap: 'wrap' }}>
            <Stat label="Payments" value={String(summary.count)} />
            <Stat label="Gross received" value={dollars(summary.grossCents)} />
            <Stat label="Processing fees" value={dollars(summary.feesCents)} />
            <Stat label="Net" value={dollars(summary.netCents)} />
            <Stat label="Refunds" value={dollars(summary.refundsCents)} />
            <Stat
              label="In flight (ACH)"
              value={String(summary.pendingCount)}
              tone={summary.pendingCount > 0 ? tokens.color.warning : undefined}
            />
          </div>
        </Card>
      )}

      <Card>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="From">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
              <option value="">All</option>
              <option value="SUCCEEDED">Succeeded</option>
              <option value="PENDING">Processing</option>
              <option value="FAILED">Failed</option>
              <option value="REFUNDED">Refunded</option>
              <option value="PARTIALLY_REFUNDED">Partially refunded</option>
            </select>
          </Field>
          <Field label="Channel">
            <select value={channel} onChange={(e) => setChannel(e.target.value)} style={inputStyle}>
              <option value="">All</option>
              <option value="Card">Card</option>
              <option value="ACH">ACH</option>
              <option value="ACH (manual)">ACH (manual)</option>
              <option value="Check">Check</option>
              <option value="Cash">Cash</option>
              <option value="Credit">Credit</option>
            </select>
          </Field>
          <Field label="Search">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load();
              }}
              placeholder="client or invoice #"
              style={{ ...inputStyle, width: 200 }}
            />
          </Field>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Apply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setStatus('');
              setChannel('');
              setQ('');
              setFrom(monthStart());
              setTo(today());
            }}
          >
            Reset
          </Button>
        </div>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 0 }}>{err}</p>}
      </Card>

      <Card>
        {loading ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        ) : (
          <Table<Row>
            columns={[
              {
                key: 'date',
                header: sortHeader('Date', 'date'),
                render: (r) => new Date(r.receivedAt).toLocaleDateString(),
              },
              {
                key: 'client',
                header: sortHeader('Client', 'client'),
                render: (r) => r.clientName,
              },
              {
                key: 'invoice',
                header: 'Invoice',
                render: (r) => (
                  <Link to={`/invoices/${r.invoiceId}`} style={{ color: tokens.color.accent }}>
                    {r.invoiceNumber}
                  </Link>
                ),
              },
              { key: 'channel', header: 'Channel', render: (r) => r.channel },
              {
                key: 'amount',
                header: sortHeader('Amount', 'amount'),
                render: (r) => dollars(r.amountCents),
              },
              {
                key: 'fee',
                header: 'Fee',
                render: (r) => (r.feeCents ? dollars(r.feeCents) : '—'),
              },
              { key: 'net', header: 'Net', render: (r) => dollars(r.netCents) },
              {
                key: 'status',
                header: sortHeader('Status', 'status'),
                render: (r) => (
                  <Pill tone={STATUS_TONE[r.status] ?? 'neutral'}>
                    {r.status === 'PENDING' ? 'PROCESSING' : r.status.replace(/_/g, ' ')}
                  </Pill>
                ),
              },
              {
                key: 'refunded',
                header: 'Refunded',
                render: (r) => (r.refundedAmountCents ? dollars(r.refundedAmountCents) : '—'),
              },
            ]}
            rows={sorted}
            rowKey={(r) => r.paymentId}
            empty="No payments in this range."
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
  tone?: string;
}): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone }}>{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label style={{ display: 'grid', gap: 2, fontSize: 11, color: tokens.color.textMuted }}>
      {label}
      {children}
    </label>
  );
}
