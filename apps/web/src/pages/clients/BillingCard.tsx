// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client billing tab. Lists invoices + open credits for this client.
// 0056 added the Credits subsection.

import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

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

interface CreditApplication {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  amountCents: number;
  appliedAt: string;
  voidedAt: string | null;
  receiptId: string | null;
}

interface CreditMemo {
  id: string;
  clientId: string;
  clientName: string;
  issuedDate: string;
  originalAmountCents: number;
  appliedCents: number;
  remainingAmountCents: number;
  source: 'MANUAL' | 'OVERPAYMENT' | 'REFUND_EXCESS';
  reference: string | null;
  notes: string | null;
  status: 'OPEN' | 'PARTIALLY_APPLIED' | 'FULLY_APPLIED' | 'VOIDED';
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
}

interface Props {
  clientId: string;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function BillingCard({ clientId }: Props): JSX.Element {
  const [items, setItems] = useState<Invoice[]>([]);
  const [credits, setCredits] = useState<CreditMemo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showVoidedCredits, setShowVoidedCredits] = useState(false);

  // New-credit form state
  const [adding, setAdding] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [newIssued, setNewIssued] = useState(() => new Date().toISOString().slice(0, 10));
  const [newAmount, setNewAmount] = useState('');
  const [newReference, setNewReference] = useState('');
  const [newNotes, setNewNotes] = useState('');

  // Applications drill-in (which memo's applications are expanded)
  const [expandedMemoId, setExpandedMemoId] = useState<string | null>(null);
  const [memoApplications, setMemoApplications] = useState<CreditApplication[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);

  async function loadInvoices(): Promise<void> {
    try {
      const r = await api<{ items: Invoice[] }>(
        `/api/staff/invoices?clientId=${encodeURIComponent(clientId)}`,
      );
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  async function loadCredits(): Promise<void> {
    try {
      const status = showVoidedCredits ? '&status=ALL' : '';
      const r = await api<{ items: CreditMemo[] }>(
        `/api/staff/credits?clientIds=${encodeURIComponent(clientId)}${status}`,
      );
      setCredits(r.items ?? []);
    } catch {
      setCredits([]);
    }
  }

  useEffect(() => {
    void loadInvoices();
    void loadCredits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, showVoidedCredits]);

  async function expandMemo(memoId: string): Promise<void> {
    if (expandedMemoId === memoId) {
      setExpandedMemoId(null);
      setMemoApplications([]);
      return;
    }
    setExpandedMemoId(memoId);
    setAppsLoading(true);
    try {
      const r = await api<{ applications: CreditApplication[] }>(
        `/api/staff/credits/${encodeURIComponent(memoId)}`,
      );
      setMemoApplications(r.applications ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_apps_failed');
    } finally {
      setAppsLoading(false);
    }
  }

  async function createCredit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const parsed = Number.parseFloat(newAmount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter a positive amount.');
      return;
    }
    const cents = Math.round(parsed * 100);
    if (cents <= 0) {
      setError('Amount must be at least $0.01.');
      return;
    }
    setError(null);
    setAddBusy(true);
    try {
      await api('/api/staff/credits', {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          issuedDate: newIssued,
          originalAmountCents: cents,
          reference: newReference.trim() || null,
          notes: newNotes.trim() || null,
        }),
      });
      setNewAmount('');
      setNewReference('');
      setNewNotes('');
      setAdding(false);
      await loadCredits();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'create_failed');
    } finally {
      setAddBusy(false);
    }
  }

  async function voidMemo(memo: CreditMemo): Promise<void> {
    const reason = window.prompt(
      `Void credit "${memo.reference ?? memo.id.slice(0, 8)}"?\n\nReason:`,
    );
    if (!reason || !reason.trim()) return;
    setError(null);
    try {
      await api(`/api/staff/credits/${encodeURIComponent(memo.id)}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      await loadCredits();
      if (expandedMemoId === memo.id) {
        await expandMemo(memo.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'void_failed');
    }
  }

  async function voidApplication(memoId: string, appId: string): Promise<void> {
    if (!window.confirm('Void this credit application? The invoice paid amount will be reduced.')) {
      return;
    }
    setError(null);
    try {
      await api(
        `/api/staff/credits/${encodeURIComponent(memoId)}/applications/${encodeURIComponent(appId)}/void`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      await Promise.all([loadCredits(), loadInvoices()]);
      // Refresh the expanded memo's applications.
      if (expandedMemoId === memoId) {
        const r = await api<{ applications: CreditApplication[] }>(
          `/api/staff/credits/${encodeURIComponent(memoId)}`,
        );
        setMemoApplications(r.applications ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'void_application_failed');
    }
  }

  const totals = items.reduce(
    (acc, i) => ({
      invoiced: acc.invoiced + i.totalCents,
      paid: acc.paid + i.paidCents,
      balance: acc.balance + (i.totalCents - i.paidCents),
    }),
    { invoiced: 0, paid: 0, balance: 0 },
  );
  const openCreditTotal = credits
    .filter((c) => c.status !== 'VOIDED' && c.status !== 'FULLY_APPLIED')
    .reduce((s, c) => s + c.remainingAmountCents, 0);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <Card title="Billing summary">
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          <Stat label="Invoiced" value={formatCents(totals.invoiced)} />
          <Stat label="Paid" value={formatCents(totals.paid)} />
          <Stat label="Outstanding" value={formatCents(totals.balance)} />
          <Stat label="Open credits" value={formatCents(openCreditTotal)} />
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

      <Card
        title={`Credits (${credits.length})`}
        action={
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
              <input
                type="checkbox"
                checked={showVoidedCredits}
                onChange={(e) => setShowVoidedCredits(e.target.checked)}
              />
              Show voided + fully applied
            </label>
            <Button size="sm" onClick={() => setAdding(!adding)}>
              {adding ? 'Cancel' : '+ New credit'}
            </Button>
          </span>
        }
      >
        {adding && (
          <form
            onSubmit={createCredit}
            style={{
              padding: 12,
              marginBottom: 16,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 2fr auto',
              gap: 12,
              alignItems: 'end',
            }}
          >
            <Input
              type="date"
              label="Issued"
              value={newIssued}
              onChange={(e) => setNewIssued(e.target.value)}
              required
            />
            <Input
              type="text"
              inputMode="decimal"
              label="Amount ($)"
              value={newAmount}
              onChange={(e) => setNewAmount(e.target.value)}
              placeholder="0.00"
              required
            />
            <Input
              label="Reference"
              value={newReference}
              onChange={(e) => setNewReference(e.target.value)}
              placeholder="Retainer deposit, refund #123, etc."
            />
            <Button type="submit" disabled={addBusy || !newAmount.trim()}>
              {addBusy ? 'Adding…' : 'Add credit'}
            </Button>
            <div style={{ gridColumn: '1 / -1' }}>
              <Input
                label="Notes"
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                placeholder="Optional context"
              />
            </div>
          </form>
        )}
        <Table<CreditMemo>
          columns={[
            { key: 'date', header: 'Issued', render: (c) => c.issuedDate },
            {
              key: 'source',
              header: 'Source',
              render: (c) => (
                <Pill tone={c.source === 'MANUAL' ? 'neutral' : 'accent'}>
                  {c.source.toLowerCase()}
                </Pill>
              ),
            },
            {
              key: 'ref',
              header: 'Reference',
              render: (c) => (
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  {c.reference ?? '—'}
                </span>
              ),
            },
            {
              key: 'orig',
              header: 'Original',
              align: 'right',
              render: (c) => formatCents(c.originalAmountCents),
            },
            {
              key: 'applied',
              header: 'Applied',
              align: 'right',
              render: (c) => formatCents(c.appliedCents),
            },
            {
              key: 'remain',
              header: 'Remaining',
              align: 'right',
              render: (c) => formatCents(c.remainingAmountCents),
            },
            {
              key: 'status',
              header: 'Status',
              render: (c) => (
                <Pill
                  tone={
                    c.status === 'OPEN'
                      ? 'accent'
                      : c.status === 'PARTIALLY_APPLIED'
                        ? 'warning'
                        : c.status === 'FULLY_APPLIED'
                          ? 'success'
                          : 'neutral'
                  }
                >
                  {c.status.replace('_', ' ').toLowerCase()}
                </Pill>
              ),
            },
            {
              key: 'actions',
              header: '',
              render: (c) => (
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  <Button size="sm" variant="ghost" onClick={() => void expandMemo(c.id)}>
                    {expandedMemoId === c.id ? 'Hide' : 'Apps'}
                  </Button>
                  {c.status !== 'VOIDED' && (
                    <Button size="sm" variant="ghost" onClick={() => void voidMemo(c)}>
                      Void
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
          rows={credits}
          rowKey={(c) => c.id}
          empty="No credits on file."
        />
        {expandedMemoId && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              background: tokens.color.surface,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.color.border}`,
            }}
          >
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 8 }}>
              Applications for credit {expandedMemoId.slice(0, 8)}…
            </div>
            {appsLoading ? (
              <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
            ) : memoApplications.length === 0 ? (
              <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
                No applications yet — apply from /payments/new.
              </p>
            ) : (
              <Table<CreditApplication>
                columns={[
                  {
                    key: 'inv',
                    header: 'Invoice',
                    render: (a) => `#${a.invoiceNumber}`,
                  },
                  {
                    key: 'amt',
                    header: 'Amount',
                    align: 'right',
                    render: (a) => formatCents(a.amountCents),
                  },
                  { key: 'when', header: 'Applied', render: (a) => a.appliedAt.slice(0, 10) },
                  {
                    key: 'status',
                    header: 'Status',
                    render: (a) =>
                      a.voidedAt ? (
                        <Pill tone="neutral">voided</Pill>
                      ) : (
                        <Pill tone="success">active</Pill>
                      ),
                  },
                  {
                    key: 'actions',
                    header: '',
                    render: (a) =>
                      a.voidedAt ? null : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void voidApplication(expandedMemoId, a.id)}
                        >
                          Void application
                        </Button>
                      ),
                  },
                ]}
                rows={memoApplications}
                rowKey={(a) => a.id}
                empty=""
              />
            )}
          </div>
        )}
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
