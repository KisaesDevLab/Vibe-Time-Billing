// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client billing tab. Lists invoices + open credits for this client.
// 0056 added the Credits subsection.

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { StatementDialog } from './StatementDialog';
import { SavedMethodsCard } from './SavedMethodsCard';
import { PaymentPlanCard } from './PaymentPlanCard';

type YearFilter = 'current' | 'prior' | 'all';

const CURRENT_YEAR = new Date().getFullYear();

function inYearRange(iso: string | null | undefined, filter: YearFilter): boolean {
  if (filter === 'all') return true;
  if (!iso) return false;
  const y = Number(iso.slice(0, 4));
  if (!Number.isFinite(y)) return false;
  return filter === 'current' ? y === CURRENT_YEAR : y === CURRENT_YEAR - 1;
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  primaryEngagementId: string | null;
  engagementTypes: string | null;
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
  clientName?: string;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function BillingCard({ clientId, clientName }: Props): JSX.Element {
  const [statementOpen, setStatementOpen] = useState(false);
  const [methodsVersion, setMethodsVersion] = useState(0);
  const [items, setItems] = useState<Invoice[]>([]);
  const [credits, setCredits] = useState<CreditMemo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [showVoidedCredits, setShowVoidedCredits] = useState(false);
  // Defaults to current year so first paint matches the bias the user
  // likely cares about — "what am I owed this year". `all` shows
  // lifetime totals, useful for client takeovers / period audits.
  const [yearFilter, setYearFilter] = useState<YearFilter>('current');

  async function sendEmail(inv: Invoice): Promise<void> {
    setSendingId(inv.id);
    setError(null);
    setNotice(null);
    // /send for DRAFT (transitions status), /resend for everything else.
    const path = inv.status === 'DRAFT' ? 'send' : 'resend';
    try {
      const r = await api<{ ok: true; emailedTo: string | null }>(
        `/api/staff/invoices/${inv.id}/${path}`,
        { method: 'POST', body: '{}' },
      );
      setNotice(
        r.emailedTo
          ? `Invoice ${inv.invoiceNumber} emailed to ${r.emailedTo}.`
          : `Invoice ${inv.invoiceNumber} marked sent (no billing email on file).`,
      );
      await loadInvoices();
    } catch (e) {
      setError(`Email failed: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      setSendingId(null);
    }
  }

  async function sendSms(inv: Invoice): Promise<void> {
    setSendingId(inv.id);
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ ok: true; textedTo: string | null }>(
        `/api/staff/invoices/${inv.id}/send-sms`,
        { method: 'POST', body: '{}' },
      );
      setNotice(`Invoice ${inv.invoiceNumber} texted to ${r.textedTo ?? 'billing contact'}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      setError(
        msg === 'no_billing_phone'
          ? 'No phone on file for the client’s billing or primary contact.'
          : msg === 'sms_opted_out'
            ? 'The billing contact has opted out of text messages (see their profile).'
            : msg === 'sms_provider_not_configured'
              ? 'SMS provider not configured. Set one up in Admin → Messaging.'
              : `SMS failed: ${msg}`,
      );
    } finally {
      setSendingId(null);
    }
  }

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

  // Filter by issue date so the summary numbers and the visible
  // invoices stay in lockstep — the user's mental model is "what I
  // see in the table is what's in the totals".
  const filteredItems = useMemo(
    () => items.filter((i) => inYearRange(i.issueDate, yearFilter)),
    [items, yearFilter],
  );
  const filteredCredits = useMemo(
    () => credits.filter((c) => inYearRange(c.issuedDate, yearFilter)),
    [credits, yearFilter],
  );

  const totals = filteredItems.reduce(
    (acc, i) => ({
      invoiced: acc.invoiced + i.totalCents,
      paid: acc.paid + i.paidCents,
      balance: acc.balance + (i.totalCents - i.paidCents),
    }),
    { invoiced: 0, paid: 0, balance: 0 },
  );
  const openCreditTotal = filteredCredits
    .filter((c) => c.status !== 'VOIDED' && c.status !== 'FULLY_APPLIED')
    .reduce((s, c) => s + c.remainingAmountCents, 0);

  // Balance-weighted average days past the due date across outstanding
  // invoices (not-yet-due count as 0). Mirrors the AR aging report.
  const avgDaysPastDue = useMemo(() => {
    const today = Date.now();
    let weighted = 0;
    let weight = 0;
    for (const i of filteredItems) {
      if (!['SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(i.status)) continue;
      const balance = i.totalCents - i.paidCents;
      if (balance <= 0) continue;
      const days = Math.max(0, Math.floor((today - Date.parse(i.dueDate)) / 86_400_000));
      weighted += days * balance;
      weight += balance;
    }
    return weight > 0 ? Math.round(weighted / weight) : 0;
  }, [filteredItems]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      {statementOpen && (
        <StatementDialog
          clientId={clientId}
          clientName={clientName ?? 'Client'}
          onClose={() => setStatementOpen(false)}
        />
      )}
      <Card
        title="Billing summary"
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button size="sm" variant="ghost" onClick={() => setStatementOpen(true)}>
              Generate statement
            </Button>
            <YearFilterToggle value={yearFilter} onChange={setYearFilter} />
          </div>
        }
      >
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))',
            gap: 16,
          }}
        >
          <Stat label={`Invoiced ${yearLabel(yearFilter)}`} value={formatCents(totals.invoiced)} />
          <Stat label="Paid" value={formatCents(totals.paid)} />
          <Stat label="Outstanding" value={formatCents(totals.balance)} />
          <Stat label="Open credits" value={formatCents(openCreditTotal)} />
          <Stat label="Avg days past due" value={String(avgDaysPastDue)} />
        </div>
      </Card>

      <SavedMethodsCard clientId={clientId} onChanged={() => setMethodsVersion((v) => v + 1)} />
      <PaymentPlanCard clientId={clientId} reloadKey={methodsVersion} />

      <Card title={`Invoices (${filteredItems.length})`}>
        {notice && (
          <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>{notice}</p>
        )}
        <Table<Invoice>
          columns={[
            {
              key: 'num',
              header: 'Number',
              render: (i) => <a href={`/invoices/${i.id}`}>{i.invoiceNumber}</a>,
            },
            {
              key: 'type',
              header: 'Engagement type',
              render: (i) => <span style={{ fontSize: 12 }}>{i.engagementTypes ?? '—'}</span>,
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
            {
              key: 'notify',
              header: '',
              render: (i) => {
                const busy = sendingId === i.id;
                return (
                  <div style={{ display: 'inline-flex', gap: 4 }}>
                    <IconButton
                      label="Open a printable PDF of this invoice"
                      glyph="🖨"
                      onClick={() => window.open(`/api/staff/invoices/${i.id}/pdf`, '_blank')}
                    />
                    {i.status !== 'VOIDED' && (
                      <>
                        <IconButton
                          label={
                            i.status === 'DRAFT'
                              ? 'Email invoice to the billing contact (marks SENT)'
                              : 'Resend invoice email to the billing contact'
                          }
                          glyph="✉"
                          disabled={busy}
                          onClick={() => void sendEmail(i)}
                        />
                        <IconButton
                          label="Text the billing contact a link to this invoice"
                          glyph="☏"
                          disabled={busy}
                          onClick={() => void sendSms(i)}
                        />
                      </>
                    )}
                  </div>
                );
              },
            },
          ]}
          rows={filteredItems}
          rowKey={(i) => i.id}
          empty={
            yearFilter === 'all'
              ? 'No invoices issued yet for this client.'
              : `No invoices in ${yearFilter === 'current' ? CURRENT_YEAR : CURRENT_YEAR - 1}. Switch to All time to see lifetime history.`
          }
        />
      </Card>

      <Card
        title={`Credits (${filteredCredits.length})`}
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
          rows={filteredCredits}
          rowKey={(c) => c.id}
          empty={
            yearFilter === 'all'
              ? 'No credits on file.'
              : `No credits in ${yearFilter === 'current' ? CURRENT_YEAR : CURRENT_YEAR - 1}.`
          }
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

interface IconButtonProps {
  label: string;
  glyph: string;
  disabled?: boolean;
  onClick: () => void;
}

function IconButton({ label, glyph, disabled, onClick }: IconButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        color: disabled ? tokens.color.textMuted : tokens.color.text,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 14,
        lineHeight: 1,
        padding: 0,
      }}
    >
      {glyph}
    </button>
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

function yearLabel(filter: YearFilter): string {
  if (filter === 'all') return '(all time)';
  if (filter === 'current') return `(${CURRENT_YEAR})`;
  return `(${CURRENT_YEAR - 1})`;
}

interface YearFilterToggleProps {
  value: YearFilter;
  onChange: (next: YearFilter) => void;
}

function YearFilterToggle({ value, onChange }: YearFilterToggleProps): JSX.Element {
  const options: Array<{ id: YearFilter; label: string }> = [
    { id: 'current', label: `${CURRENT_YEAR}` },
    { id: 'prior', label: `${CURRENT_YEAR - 1}` },
    { id: 'all', label: 'All time' },
  ];
  return (
    <div
      role="group"
      aria-label="Filter by year"
      style={{
        display: 'inline-flex',
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        overflow: 'hidden',
        background: tokens.color.surface,
      }}
    >
      {options.map((opt, i) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            aria-pressed={active}
            style={{
              padding: '6px 12px',
              border: 'none',
              borderLeft: i === 0 ? 'none' : `1px solid ${tokens.color.border}`,
              background: active ? tokens.color.accentMuted : 'transparent',
              color: active ? tokens.color.accent : tokens.color.text,
              fontSize: 12,
              fontFamily: tokens.font.body,
              fontWeight: active ? 600 : 500,
              cursor: 'pointer',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
