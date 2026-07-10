// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client-scoped Tax Payments card. Same data the admin TaxPayments
// page exposed; pre-filtered to the client we're looking at. Used
// on the ClientDetail Billing tab so staff manage tax obligations
// where the rest of the client's financial picture lives.

import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Stat, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { dollarsInputToCents } from '../../lib/money';

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

interface EngagementOption {
  id: string;
  name: string;
  clientId: string;
}

interface JurisdictionOption {
  id: string;
  name: string;
  active: boolean;
}

interface PaymentTypeOption {
  id: string;
  jurisdictionId: string;
  name: string;
  paymentUrl: string | null;
  active: boolean;
}

interface Props {
  clientId: string;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const statusTone = (s: TaxPaymentRow['status']): 'success' | 'warning' | 'neutral' =>
  s === 'PAID' ? 'success' : s === 'SCHEDULED' ? 'warning' : 'neutral';

export function TaxPaymentsCard({ clientId }: Props): JSX.Element {
  const [items, setItems] = useState<TaxPaymentRow[]>([]);
  const [engagements, setEngagements] = useState<EngagementOption[]>([]);
  const [jurisdictions, setJurisdictions] = useState<JurisdictionOption[]>([]);
  const [paymentTypes, setPaymentTypes] = useState<PaymentTypeOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Composer (inline; not a separate modal). The jurisdiction + type
  // dropdowns are dependent — picking a jurisdiction filters the
  // type list to entries owned by that jurisdiction.
  const [showCreate, setShowCreate] = useState(false);
  const [createEngagementId, setCreateEngagementId] = useState('');
  const [createJurisdictionId, setCreateJurisdictionId] = useState('');
  const [createPaymentTypeId, setCreatePaymentTypeId] = useState('');
  const [createTaxYear, setCreateTaxYear] = useState<number | ''>('');
  const [createAmount, setCreateAmount] = useState('');
  const [createDueDate, setCreateDueDate] = useState('');
  const [createNotes, setCreateNotes] = useState('');

  // Mark-paid inline form (per row).
  const [markPaidId, setMarkPaidId] = useState<string | null>(null);
  const [paidDate, setPaidDate] = useState('');
  const [confirmationNumber, setConfirmationNumber] = useState('');

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: TaxPaymentRow[] }>(
        `/api/staff/tax-payments?clientId=${encodeURIComponent(clientId)}`,
      );
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function openCreate(): Promise<void> {
    setError(null);
    setShowCreate(true);
    if (engagements.length === 0) {
      try {
        const r = await api<{ items: EngagementOption[] }>(
          `/api/staff/engagements?clientId=${encodeURIComponent(clientId)}`,
        );
        setEngagements(r.items ?? []);
      } catch {
        // Engagement select stays empty; tax payments can still be saved without one.
      }
    }
    // 0090 — load the firm's jurisdiction + payment-type catalog. The
    // type dropdown gets filtered to the picked jurisdiction at render.
    try {
      const [j, t] = await Promise.all([
        api<{ items: JurisdictionOption[] }>('/api/staff/admin/tax-jurisdictions'),
        api<{ items: PaymentTypeOption[] }>('/api/staff/admin/tax-payment-types'),
      ]);
      setJurisdictions((j.items ?? []).filter((x) => x.active));
      setPaymentTypes((t.items ?? []).filter((x) => x.active));
    } catch {
      // Catalog empty → the form will tell the user to configure it.
    }
  }

  async function performCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    const juris = jurisdictions.find((j) => j.id === createJurisdictionId);
    const type = paymentTypes.find((t) => t.id === createPaymentTypeId);
    if (!juris || !type || !createDueDate) return;
    const amountCents = dollarsInputToCents(createAmount);
    if (amountCents == null || amountCents < 0) {
      setError('Amount must be a non-negative number.');
      return;
    }
    setError(null);
    try {
      // Send the resolved names (so historical rows survive catalog
      // deletes) + the resolved URL snapshot (so the portal link is
      // stable). The API stores all three as text on tax_payment.
      const body: Record<string, unknown> = {
        clientId,
        jurisdiction: juris.name,
        paymentType: type.name,
        amountCents,
        dueDate: createDueDate,
      };
      if (type.paymentUrl) body['paymentUrl'] = type.paymentUrl;
      if (createEngagementId) body['engagementId'] = createEngagementId;
      if (createTaxYear !== '') body['taxYear'] = Number(createTaxYear);
      if (createNotes) body['notes'] = createNotes;
      await api('/api/staff/tax-payments', { method: 'POST', body: JSON.stringify(body) });
      setShowCreate(false);
      setCreateEngagementId('');
      setCreateJurisdictionId('');
      setCreatePaymentTypeId('');
      setCreateTaxYear('');
      setCreateAmount('');
      setCreateDueDate('');
      setCreateNotes('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create_failed');
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
      setError(err instanceof Error ? err.message : 'mark_paid_failed');
    }
  }

  async function performVoid(id: string): Promise<void> {
    const reason = window.prompt('Void this tax payment? Reason:');
    if (!reason || !reason.trim()) return;
    setError(null);
    try {
      await api(`/api/staff/tax-payments/${id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'void_failed');
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const scheduled = items.filter((i) => i.status === 'SCHEDULED');
  const overdue = scheduled.filter((i) => i.dueDate < today);
  const totalScheduledCents = scheduled.reduce((s, i) => s + i.amountCents, 0);

  return (
    <Card
      title="Tax payments"
      action={
        <Button
          size="sm"
          variant={showCreate ? 'ghost' : 'secondary'}
          onClick={() => void openCreate()}
        >
          {showCreate ? 'Cancel' : '+ Schedule tax payment'}
        </Button>
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
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: tokens.space.md,
          marginBottom: tokens.space.md,
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

      {showCreate && (
        <form
          onSubmit={performCreate}
          style={{
            display: 'grid',
            gap: 10,
            padding: 12,
            marginBottom: 14,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
          }}
        >
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
            Schedules a tax obligation for this client. They&apos;ll see it on the portal home page
            with the due date. Notes stay firm-internal.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <LabeledSelect
              label="Jurisdiction *"
              value={createJurisdictionId}
              onChange={(v) => {
                setCreateJurisdictionId(v);
                // Reset the dependent payment-type pick whenever the
                // jurisdiction changes so the user can't keep a stale
                // selection from a different jurisdiction.
                setCreatePaymentTypeId('');
              }}
              options={[
                { value: '', label: 'Select…' },
                ...jurisdictions.map((j) => ({ value: j.id, label: j.name })),
              ]}
            />
            <LabeledSelect
              label="Payment type *"
              value={createPaymentTypeId}
              onChange={setCreatePaymentTypeId}
              disabled={!createJurisdictionId}
              options={[
                {
                  value: '',
                  label: createJurisdictionId ? 'Select…' : 'Pick a jurisdiction first',
                },
                ...paymentTypes
                  .filter((t) => t.jurisdictionId === createJurisdictionId)
                  .map((t) => ({
                    value: t.id,
                    label: t.paymentUrl ? `${t.name} (online)` : t.name,
                  })),
              ]}
            />
            <LabeledSelect
              label="Engagement (optional)"
              value={createEngagementId}
              onChange={setCreateEngagementId}
              options={[
                { value: '', label: '— None —' },
                ...engagements.map((e) => ({ value: e.id, label: e.name })),
              ]}
            />
            <Input
              label="Tax year"
              type="number"
              value={createTaxYear === '' ? '' : String(createTaxYear)}
              onChange={(e) =>
                setCreateTaxYear(e.target.value === '' ? '' : Number(e.target.value))
              }
              placeholder={`${new Date().getFullYear()}`}
            />
            <Input
              label="Amount (USD) *"
              value={createAmount}
              onChange={(e) => setCreateAmount(e.target.value)}
              placeholder="2500.00"
              required
            />
            <Input
              label="Due date *"
              type="date"
              value={createDueDate}
              onChange={(e) => setCreateDueDate(e.target.value)}
              required
            />
          </div>
          {(() => {
            const t = paymentTypes.find((x) => x.id === createPaymentTypeId);
            if (!t?.paymentUrl) return null;
            return (
              <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
                Client portal link:{' '}
                <a href={t.paymentUrl} target="_blank" rel="noopener noreferrer">
                  {t.paymentUrl}
                </a>
              </p>
            );
          })()}
          {jurisdictions.length === 0 && (
            <p style={{ fontSize: 12, color: tokens.color.warning, margin: 0 }}>
              No jurisdictions configured yet — set them up in{' '}
              <strong>Admin → Catalog → Tax payments</strong>.
            </p>
          )}
          <Input
            label="Internal notes (not shown to client)"
            value={createNotes}
            onChange={(e) => setCreateNotes(e.target.value)}
            placeholder="Optional"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="submit" size="sm">
              Schedule
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {items.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          No tax payments scheduled. Use <strong>+ Schedule tax payment</strong> to add one — the
          client will see it on their portal home page.
        </p>
      ) : (
        <Table<TaxPaymentRow>
          columns={[
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
              render: (r) =>
                r.status === 'SCHEDULED' ? (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setMarkPaidId(r.id);
                        setPaidDate(today);
                      }}
                    >
                      Mark paid
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void performVoid(r.id)}
                    >
                      Void
                    </Button>
                  </div>
                ) : null,
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
        />
      )}

      {markPaidId && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            display: 'grid',
            gap: 8,
          }}
        >
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
            Recording payment for {items.find((i) => i.id === markPaidId)?.jurisdiction ?? 'this'}…
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
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
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" onClick={() => void performMarkPaid()} disabled={!paidDate}>
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMarkPaidId(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

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
      <label htmlFor={id} style={{ fontSize: 11, color: tokens.color.textMuted }}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          padding: '10px 12px',
          fontSize: 14,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          background: tokens.color.surface,
          color: disabled ? tokens.color.textMuted : tokens.color.text,
          fontFamily: tokens.font.body,
          boxSizing: 'border-box',
          width: '100%',
          opacity: disabled ? 0.7 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
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
