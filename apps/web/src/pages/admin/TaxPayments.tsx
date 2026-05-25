// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP1 — Tax Payments admin page. Staff create / track scheduled tax
// obligations for clients; clients see the same rows in the portal
// (CP2). KPI strip + table + inline create form. Mark-paid + void
// actions per row.

import { useEffect, useState } from 'react';

import {
  Button,
  Card,
  EmptyState,
  Input,
  Pill,
  SectionHeading,
  Stat,
  Table,
  tokens,
} from '@vibe/ui';

import { api } from '../../api-client';
import { centsToDollarsInput, dollarsInputToCents } from '../../lib/money';

interface TaxPaymentRow {
  id: string;
  clientId: string;
  engagementId: string | null;
  jurisdiction: string;
  paymentType: string;
  taxYear: number | null;
  amountCents: number;
  dueDate: string;
  status: 'SCHEDULED' | 'PAID' | 'VOIDED';
  paidDate: string | null;
  confirmationNumber: string | null;
  notes: string | null;
}

interface ClientOption {
  id: string;
  name: string;
}

interface EngagementOption {
  id: string;
  name: string;
  clientId: string;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const statusTone = (s: TaxPaymentRow['status']): 'success' | 'warning' | 'neutral' =>
  s === 'PAID' ? 'success' : s === 'SCHEDULED' ? 'warning' : 'neutral';

export function TaxPaymentsPage(): JSX.Element {
  const [items, setItems] = useState<TaxPaymentRow[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [engagements, setEngagements] = useState<EngagementOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [createClientId, setCreateClientId] = useState('');
  const [createEngagementId, setCreateEngagementId] = useState('');
  const [createJurisdiction, setCreateJurisdiction] = useState('');
  const [createPaymentType, setCreatePaymentType] = useState('');
  const [createTaxYear, setCreateTaxYear] = useState<number | ''>('');
  const [createAmount, setCreateAmount] = useState('');
  const [createDueDate, setCreateDueDate] = useState('');
  const [createNotes, setCreateNotes] = useState('');

  // Mark-paid modal
  const [markPaidId, setMarkPaidId] = useState<string | null>(null);
  const [paidDate, setPaidDate] = useState('');
  const [confirmationNumber, setConfirmationNumber] = useState('');

  // Void modal
  const [voidId, setVoidId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: TaxPaymentRow[] }>('/api/staff/tax-payments');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function openCreate(): Promise<void> {
    setError(null);
    setShowCreate(true);
    if (clients.length === 0) {
      try {
        const r = await api<{ items: ClientOption[] }>('/api/staff/clients');
        setClients(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load clients failed');
      }
    }
    if (engagements.length === 0) {
      try {
        const r = await api<{ items: EngagementOption[] }>('/api/staff/engagements');
        setEngagements(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load engagements failed');
      }
    }
  }

  async function performCreate(): Promise<void> {
    if (!createClientId || !createJurisdiction || !createPaymentType || !createDueDate) return;
    const amountCents = dollarsInputToCents(createAmount);
    if (amountCents == null || amountCents < 0) {
      setError('amount must be ≥ 0');
      return;
    }
    setError(null);
    try {
      const body: Record<string, unknown> = {
        clientId: createClientId,
        jurisdiction: createJurisdiction,
        paymentType: createPaymentType,
        amountCents,
        dueDate: createDueDate,
      };
      if (createEngagementId) body['engagementId'] = createEngagementId;
      if (createTaxYear !== '') body['taxYear'] = Number(createTaxYear);
      if (createNotes) body['notes'] = createNotes;
      await api('/api/staff/tax-payments', { method: 'POST', body: JSON.stringify(body) });
      setShowCreate(false);
      setCreateClientId('');
      setCreateEngagementId('');
      setCreateJurisdiction('');
      setCreatePaymentType('');
      setCreateTaxYear('');
      setCreateAmount('');
      setCreateDueDate('');
      setCreateNotes('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create failed');
    }
  }

  async function performMarkPaid(): Promise<void> {
    if (!markPaidId || !paidDate) return;
    setError(null);
    try {
      await api(`/api/staff/tax-payments/${markPaidId}/mark-paid`, {
        method: 'POST',
        body: JSON.stringify({
          paidDate,
          ...(confirmationNumber ? { confirmationNumber } : {}),
        }),
      });
      setMarkPaidId(null);
      setPaidDate('');
      setConfirmationNumber('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'mark-paid failed');
    }
  }

  async function performVoid(): Promise<void> {
    if (!voidId || !voidReason) return;
    setError(null);
    try {
      await api(`/api/staff/tax-payments/${voidId}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: voidReason }),
      });
      setVoidId(null);
      setVoidReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'void failed');
    }
  }

  // KPI math
  const today = new Date().toISOString().slice(0, 10);
  const scheduled = items.filter((i) => i.status === 'SCHEDULED');
  const overdue = scheduled.filter((i) => i.dueDate < today);
  const totalScheduledCents = scheduled.reduce((s, i) => s + i.amountCents, 0);
  const clientName = (id: string): string =>
    clients.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <SectionHeading
        title="Tax payments"
        description="Schedule tax obligations for your clients. They appear on the client portal with due dates and reminders."
        action={
          <Button type="button" onClick={() => void openCreate()}>
            New tax payment
          </Button>
        }
      />

      <Card title="At a glance">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: tokens.space.md,
          }}
        >
          <Stat
            label="Scheduled"
            value={scheduled.length}
            tone={scheduled.length > 0 ? 'accent' : 'neutral'}
          />
          <Stat
            label="Overdue"
            value={overdue.length}
            tone={overdue.length > 0 ? 'danger' : 'neutral'}
          />
          <Stat label="Total scheduled" value={formatCents(totalScheduledCents)} />
        </div>
      </Card>

      <Card title="All tax payments">
        {items.length === 0 ? (
          <EmptyState
            icon="📅"
            title="No tax payments yet"
            body="Use the New tax payment button to schedule the first one. Clients see them on their portal home page."
          />
        ) : (
          <Table<TaxPaymentRow>
            columns={[
              { key: 'client', header: 'Client', render: (r) => clientName(r.clientId) },
              {
                key: 'jur',
                header: 'Jurisdiction',
                render: (r) => (
                  <span>
                    {r.jurisdiction}
                    {r.taxYear && (
                      <span style={{ color: tokens.color.textMuted }}> · TY{r.taxYear}</span>
                    )}
                  </span>
                ),
              },
              { key: 'type', header: 'Type', render: (r) => r.paymentType },
              {
                key: 'amount',
                header: 'Amount',
                align: 'right',
                render: (r) => formatCents(r.amountCents),
              },
              {
                key: 'due',
                header: 'Due',
                render: (r) => (
                  <span
                    style={{
                      color:
                        r.status === 'SCHEDULED' && r.dueDate < today
                          ? tokens.color.danger
                          : tokens.color.text,
                    }}
                  >
                    {r.dueDate}
                  </span>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
              },
              {
                key: 'actions',
                header: '',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 4 }}>
                    {r.status === 'SCHEDULED' && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setMarkPaidId(r.id)}
                        >
                          Mark paid
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setVoidId(r.id)}
                        >
                          Void
                        </Button>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
            rows={items}
            rowKey={(r) => r.id}
          />
        )}
      </Card>

      {showCreate && (
        <Card title="Schedule a tax payment">
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
            The client sees this entry on their portal home page. The notes field is firm-internal
            and never exposed to the portal.
          </p>
          <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
            <LabeledSelect
              label="Client *"
              value={createClientId}
              onChange={setCreateClientId}
              options={[
                { value: '', label: 'Select…' },
                ...clients.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
            <LabeledSelect
              label="Engagement (optional)"
              value={createEngagementId}
              onChange={setCreateEngagementId}
              disabled={!createClientId}
              options={[
                { value: '', label: '— None —' },
                ...engagements
                  .filter((e) => e.clientId === createClientId)
                  .map((e) => ({ value: e.id, label: e.name })),
              ]}
            />
            <Input
              label="Jurisdiction *"
              value={createJurisdiction}
              onChange={(e) => setCreateJurisdiction(e.target.value)}
              placeholder="Federal · State - CA · Local - Oakland"
            />
            <Input
              label="Payment type *"
              value={createPaymentType}
              onChange={(e) => setCreatePaymentType(e.target.value)}
              placeholder="Estimated · Extension · Balance due · Quarterly"
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Input
                label="Tax year"
                type="number"
                value={createTaxYear === '' ? '' : String(createTaxYear)}
                onChange={(e) =>
                  setCreateTaxYear(e.target.value === '' ? '' : Number(e.target.value))
                }
                placeholder="2026"
              />
              <Input
                label="Amount (USD) *"
                value={createAmount}
                onChange={(e) => setCreateAmount(e.target.value)}
                placeholder="2500.00"
              />
            </div>
            <Input
              label="Due date *"
              type="date"
              value={createDueDate}
              onChange={(e) => setCreateDueDate(e.target.value)}
            />
            <Input
              label="Internal notes (not shown to client)"
              value={createNotes}
              onChange={(e) => setCreateNotes(e.target.value)}
              placeholder="Optional"
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button type="button" onClick={() => void performCreate()}>
                Schedule
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {markPaidId && (
        <Card title="Mark paid">
          <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
            <Input
              label="Paid date *"
              type="date"
              value={paidDate}
              onChange={(e) => setPaidDate(e.target.value)}
            />
            <Input
              label="Confirmation number"
              value={confirmationNumber}
              onChange={(e) => setConfirmationNumber(e.target.value)}
              placeholder="Optional"
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button type="button" onClick={() => void performMarkPaid()}>
                Confirm
              </Button>
              <Button type="button" variant="ghost" onClick={() => setMarkPaidId(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {voidId && (
        <Card title="Void tax payment">
          <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
            Voiding hides this entry from the client portal. Use credit-memo via the AR flow if a
            refund is needed for a paid one.
          </p>
          <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
            <Input
              label="Reason *"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. duplicate entry, payment cancelled"
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button type="button" variant="danger" onClick={() => void performVoid()}>
                Void
              </Button>
              <Button type="button" variant="ghost" onClick={() => setVoidId(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}

// Small select wrapper that mirrors Input's label-prop pattern so the
// jsx-a11y rule sees an htmlFor/id pair instead of nested-label.
function LabeledSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
}): JSX.Element {
  const id = `select-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 12, color: tokens.color.textMuted }}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          padding: '8px 10px',
          fontSize: 13,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          background: tokens.color.surface,
          color: tokens.color.text,
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// Suppress lint when unused.
void centsToDollarsInput;
