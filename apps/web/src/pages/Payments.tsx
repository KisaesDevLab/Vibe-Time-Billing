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
  receiptId: string | null;
  voided: boolean;
  canEdit: boolean;
  canVoid: boolean;
}

interface ClientLite {
  id: string;
  name: string;
}
interface OutstandingInvoice {
  id: string;
  invoiceNumber: string;
  openCents: number;
}
interface MethodOpt {
  key: string;
  label: string;
  active: boolean;
  displayOrder: number;
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

  // Drawer (create + edit + reapply + receipt drill-in)
  const [drawer, setDrawer] = useState<'create' | 'edit' | 'reapply' | 'receipt' | null>(null);
  const [editRow, setEditRow] = useState<Row | null>(null);
  const [reapplyRow, setReapplyRow] = useState<Row | null>(null);
  const [saving, setSaving] = useState(false);
  const [drawerErr, setDrawerErr] = useState<string | null>(null);
  // create form
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [methods, setMethods] = useState<MethodOpt[]>([]);
  const [cClient, setCClient] = useState('');
  const [cMethod, setCMethod] = useState('');
  const [cAmount, setCAmount] = useState(''); // amount received
  const [cDate, setCDate] = useState(today());
  const [cRef, setCRef] = useState('');
  // allocation lines (shared by create + reapply): per-invoice amount strings
  const [allocLines, setAllocLines] = useState<
    { invoiceId: string; invoiceNumber: string; openCents: number; amount: string }[]
  >([]);
  // edit form
  const [eAmount, setEAmount] = useState('');
  const [eDate, setEDate] = useState('');
  // receipt drill-in
  const [receiptItems, setReceiptItems] = useState<
    {
      paymentId: string;
      invoiceNumber: string;
      amountCents: number;
      status: string;
      voided: boolean;
    }[]
  >([]);

  const allocTotalCents = useMemo(
    () => allocLines.reduce((s, l) => s + (Math.round(Number(l.amount) * 100) || 0), 0),
    [allocLines],
  );

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

  function openCreate(): void {
    setDrawer('create');
    setDrawerErr(null);
    setCClient('');
    setCMethod('');
    setCAmount('');
    setCDate(today());
    setCRef('');
    setAllocLines([]);
    if (clients.length === 0)
      void api<{ items: ClientLite[] }>('/api/staff/clients?pageSize=200')
        .then((r) => setClients(r.items ?? []))
        .catch(() => undefined);
    if (methods.length === 0)
      void api<{ items: MethodOpt[] }>('/api/staff/admin/payment-method-types')
        .then((r) => setMethods((r.items ?? []).filter((m) => m.active)))
        .catch(() => undefined);
  }

  // Load the client's open invoices into allocation lines (create mode).
  useEffect(() => {
    if (drawer !== 'create' || !cClient) {
      if (drawer === 'create') setAllocLines([]);
      return;
    }
    void api<{ items: OutstandingInvoice[] }>(
      `/api/staff/payments/outstanding?clientIds=${encodeURIComponent(cClient)}`,
    )
      .then((r) =>
        setAllocLines(
          (r.items ?? []).map((o) => ({
            invoiceId: o.id,
            invoiceNumber: o.invoiceNumber,
            openCents: o.openCents,
            amount: '',
          })),
        ),
      )
      .catch(() => setAllocLines([]));
  }, [drawer, cClient]);

  function setLineAmount(invoiceId: string, amount: string): void {
    setAllocLines((prev) => prev.map((l) => (l.invoiceId === invoiceId ? { ...l, amount } : l)));
  }

  // Auto-allocate the received amount across open invoices, oldest first.
  function autoAllocate(): void {
    let remaining = Math.round(Number(cAmount) * 100) || 0;
    setAllocLines((prev) =>
      prev.map((l) => {
        const take = Math.min(remaining, l.openCents);
        remaining -= take;
        return { ...l, amount: take > 0 ? (take / 100).toFixed(2) : '' };
      }),
    );
  }

  function openEdit(row: Row): void {
    setEditRow(row);
    setEAmount((row.amountCents / 100).toFixed(2));
    setEDate(row.receivedAt.slice(0, 10));
    setDrawerErr(null);
    setDrawer('edit');
  }

  function openReapply(row: Row): void {
    setReapplyRow(row);
    setDrawerErr(null);
    setDrawer('reapply');
    setAllocLines([]);
    void api<{ items: OutstandingInvoice[] }>(
      `/api/staff/payments/outstanding?clientIds=${encodeURIComponent(row.clientId)}`,
    )
      .then((r) => {
        const items = r.items ?? [];
        // Ensure the payment's current invoice is present + pre-filled.
        if (!items.some((o) => o.id === row.invoiceId)) {
          items.unshift({ id: row.invoiceId, invoiceNumber: row.invoiceNumber, openCents: 0 });
        }
        setAllocLines(
          items.map((o) => ({
            invoiceId: o.id,
            invoiceNumber: o.invoiceNumber,
            openCents: o.openCents,
            amount: o.id === row.invoiceId ? (row.amountCents / 100).toFixed(2) : '',
          })),
        );
      })
      .catch(() => setAllocLines([]));
  }

  async function openReceipt(row: Row): Promise<void> {
    if (!row.receiptId) return;
    setDrawerErr(null);
    setReceiptItems([]);
    setDrawer('receipt');
    try {
      const r = await api<{ items: typeof receiptItems }>(
        `/api/staff/payments/receipt/${row.receiptId}`,
      );
      setReceiptItems(r.items);
    } catch (e) {
      setDrawerErr(e instanceof Error ? e.message : 'load_failed');
    }
  }

  async function saveCreate(): Promise<void> {
    setSaving(true);
    setDrawerErr(null);
    try {
      const received = Math.round(Number(cAmount) * 100);
      const allocations = allocLines
        .filter((l) => Math.round(Number(l.amount) * 100) > 0)
        .map((l) => ({ invoiceId: l.invoiceId, amountCents: Math.round(Number(l.amount) * 100) }));
      if (allocations.length === 0) throw new Error('allocate to at least one invoice');
      await api('/api/staff/payments/receive', {
        method: 'POST',
        body: JSON.stringify({
          payerClientId: cClient,
          paymentDate: cDate,
          paymentMethod: cMethod,
          reference: cRef || null,
          amountReceivedCents: received,
          allocations,
        }),
      });
      setDrawer(null);
      await load();
    } catch (e) {
      setDrawerErr(e instanceof Error ? e.message : 'create_failed');
    } finally {
      setSaving(false);
    }
  }

  async function saveReapply(): Promise<void> {
    if (!reapplyRow) return;
    setSaving(true);
    setDrawerErr(null);
    try {
      const allocations = allocLines
        .filter((l) => Math.round(Number(l.amount) * 100) > 0)
        .map((l) => ({ invoiceId: l.invoiceId, amountCents: Math.round(Number(l.amount) * 100) }));
      await api(`/api/staff/payments/${reapplyRow.paymentId}/reapply`, {
        method: 'POST',
        body: JSON.stringify({ allocations }),
      });
      setDrawer(null);
      setReapplyRow(null);
      await load();
    } catch (e) {
      setDrawerErr(e instanceof Error ? e.message : 'reapply_failed');
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(): Promise<void> {
    if (!editRow) return;
    setSaving(true);
    setDrawerErr(null);
    try {
      await api(`/api/staff/payments/${editRow.paymentId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          amountCents: Math.round(Number(eAmount) * 100),
          receivedAt: eDate,
        }),
      });
      setDrawer(null);
      setEditRow(null);
      await load();
    } catch (e) {
      setDrawerErr(e instanceof Error ? e.message : 'edit_failed');
    } finally {
      setSaving(false);
    }
  }

  async function voidRow(row: Row): Promise<void> {
    const reason = window.prompt('Void this payment? Optional reason:', '');
    if (reason === null) return; // cancelled
    try {
      await api(`/api/staff/payments/${row.paymentId}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason || null }),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'void_failed');
    }
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
            <Button size="sm" onClick={openCreate}>
              + Record payment
            </Button>
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
              <option value="Terminal">Terminal (in person)</option>
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
                render: (r) =>
                  r.voided ? (
                    <Pill tone="neutral">VOIDED</Pill>
                  ) : (
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
              {
                key: 'actions',
                header: '',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {r.receiptId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void openReceipt(r)}
                        title="Show all invoices this payment was applied to"
                      >
                        Receipt
                      </Button>
                    )}
                    {r.canEdit && (
                      <Button size="sm" variant="ghost" onClick={() => openReapply(r)}>
                        Re-apply
                      </Button>
                    )}
                    {r.canEdit && (
                      <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>
                        Edit
                      </Button>
                    )}
                    {r.canVoid && (
                      <Button size="sm" variant="ghost" onClick={() => void voidRow(r)}>
                        Void
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={sorted}
            rowKey={(r) => r.paymentId}
            empty="No payments in this range."
          />
        )}
      </Card>

      {drawer && (
        <Drawer
          title={
            drawer === 'create'
              ? 'Record a payment'
              : drawer === 'edit'
                ? 'Edit payment'
                : drawer === 'reapply'
                  ? 'Re-apply payment'
                  : 'Payment receipt'
          }
          onClose={() => {
            setDrawer(null);
            setEditRow(null);
            setReapplyRow(null);
          }}
        >
          {drawerErr && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{drawerErr}</p>}

          {drawer === 'create' && (
            <div style={{ display: 'grid', gap: 10 }}>
              <Field label="Client">
                <select
                  value={cClient}
                  onChange={(e) => setCClient(e.target.value)}
                  style={inputStyle}
                >
                  <option value="">— pick a client —</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div style={{ display: 'flex', gap: 8 }}>
                <Field label="Method">
                  <select
                    value={cMethod}
                    onChange={(e) => setCMethod(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">— method —</option>
                    {methods.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Amount received ($)">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={cAmount}
                    onChange={(e) => setCAmount(e.target.value)}
                    style={inputStyle}
                  />
                </Field>
                <Field label="Date">
                  <input
                    type="date"
                    value={cDate}
                    onChange={(e) => setCDate(e.target.value)}
                    style={inputStyle}
                  />
                </Field>
              </div>
              <Field label="Reference (optional)">
                <input
                  value={cRef}
                  onChange={(e) => setCRef(e.target.value)}
                  style={inputStyle}
                  placeholder="check # / memo"
                />
              </Field>

              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  Apply to invoices
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={autoAllocate}
                  disabled={!cClient || !cAmount}
                >
                  Auto-allocate
                </Button>
              </div>
              <AllocList lines={allocLines} onChange={setLineAmount} inputStyle={inputStyle} />
              <AllocTotals
                allocatedCents={allocTotalCents}
                receivedCents={Math.round(Number(cAmount) * 100) || 0}
                mode="create"
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Button
                  size="sm"
                  onClick={() => void saveCreate()}
                  disabled={saving || !cClient || !cMethod || !cAmount || allocTotalCents === 0}
                >
                  {saving ? 'Recording…' : 'Record payment'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDrawer(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {drawer === 'edit' && (
            <div style={{ display: 'grid', gap: 10 }}>
              <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
                Editing a manually-recorded payment. To change which invoices it covers, use
                Re-apply; method/reference are set on the original receipt.
              </p>
              <Field label="Amount ($)">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={eAmount}
                  onChange={(e) => setEAmount(e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <Field label="Date">
                <input
                  type="date"
                  value={eDate}
                  onChange={(e) => setEDate(e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Button size="sm" onClick={() => void saveEdit()} disabled={saving || !eAmount}>
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDrawer(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {drawer === 'reapply' && reapplyRow && (
            <div style={{ display: 'grid', gap: 10 }}>
              <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
                Move or split <strong>{dollars(reapplyRow.amountCents)}</strong> from #
                {reapplyRow.invoiceNumber} across this client&apos;s invoices. The allocations must
                total the payment amount.
              </p>
              <AllocList lines={allocLines} onChange={setLineAmount} inputStyle={inputStyle} />
              <AllocTotals
                allocatedCents={allocTotalCents}
                receivedCents={reapplyRow.amountCents}
                mode="reapply"
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Button
                  size="sm"
                  onClick={() => void saveReapply()}
                  disabled={saving || allocTotalCents !== reapplyRow.amountCents}
                >
                  {saving ? 'Re-applying…' : 'Re-apply'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDrawer(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {drawer === 'receipt' && (
            <div style={{ display: 'grid', gap: 8 }}>
              <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
                All invoices this payment was applied to.
              </p>
              {receiptItems.map((it) => (
                <div
                  key={it.paymentId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '6px 0',
                    borderBottom: `1px solid ${tokens.color.border}`,
                    fontSize: 13,
                    opacity: it.voided ? 0.5 : 1,
                  }}
                >
                  <span>
                    #{it.invoiceNumber}
                    {it.voided && ' (voided)'}
                  </span>
                  <span style={{ fontWeight: 600 }}>{dollars(it.amountCents)}</span>
                </div>
              ))}
              {receiptItems.length === 0 && (
                <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
              )}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 13,
                  fontWeight: 700,
                  marginTop: 4,
                }}
              >
                <span>Total applied</span>
                <span>
                  {dollars(
                    receiptItems.filter((i) => !i.voided).reduce((s, i) => s + i.amountCents, 0),
                  )}
                </span>
              </div>
            </div>
          )}
        </Drawer>
      )}
    </div>
  );
}

function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.3)',
        zIndex: 50,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        style={{
          width: 420,
          maxWidth: '90vw',
          height: '100%',
          background: tokens.color.surface,
          borderLeft: `1px solid ${tokens.color.border}`,
          padding: tokens.space.lg,
          overflowY: 'auto',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.12)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 0,
              fontSize: 20,
              cursor: 'pointer',
              color: tokens.color.textMuted,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
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

function AllocList({
  lines,
  onChange,
  inputStyle,
}: {
  lines: { invoiceId: string; invoiceNumber: string; openCents: number; amount: string }[];
  onChange: (invoiceId: string, amount: string) => void;
  inputStyle: React.CSSProperties;
}): JSX.Element {
  if (lines.length === 0) {
    return (
      <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>No open invoices.</p>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
      {lines.map((l) => (
        <div key={l.invoiceId} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ flex: 1, fontSize: 13 }}>
            #{l.invoiceNumber}
            <span style={{ color: tokens.color.textMuted, fontSize: 11, marginLeft: 6 }}>
              open {dollars(l.openCents)}
            </span>
          </div>
          <input
            type="number"
            min="0"
            step="0.01"
            value={l.amount}
            placeholder="0.00"
            onChange={(e) => onChange(l.invoiceId, e.target.value)}
            style={{ ...inputStyle, width: 110, textAlign: 'right' }}
            aria-label={`Amount for invoice ${l.invoiceNumber}`}
          />
        </div>
      ))}
    </div>
  );
}

function AllocTotals({
  allocatedCents,
  receivedCents,
  mode,
}: {
  allocatedCents: number;
  receivedCents: number;
  mode: 'create' | 'reapply';
}): JSX.Element {
  const diff = receivedCents - allocatedCents;
  return (
    <div
      style={{
        fontSize: 12,
        display: 'grid',
        gap: 2,
        borderTop: `1px solid ${tokens.color.border}`,
        paddingTop: 6,
      }}
    >
      <Row label="Allocated" value={dollars(allocatedCents)} />
      <Row
        label={mode === 'create' ? 'Received' : 'Payment amount'}
        value={dollars(receivedCents)}
      />
      {mode === 'create' && diff > 0 && (
        <div style={{ color: tokens.color.warning }}>
          {dollars(diff)} unapplied → becomes a client credit.
        </div>
      )}
      {mode === 'create' && diff < 0 && (
        <div style={{ color: tokens.color.danger }}>
          Allocated exceeds received by {dollars(-diff)}.
        </div>
      )}
      {mode === 'reapply' && diff !== 0 && (
        <div style={{ color: tokens.color.danger }}>
          Must total the payment amount (off by {dollars(Math.abs(diff))}).
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: tokens.color.textMuted }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}
