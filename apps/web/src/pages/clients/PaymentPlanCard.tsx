/* eslint-disable jsx-a11y/label-has-associated-control -- labels wrap their controls inside grid forms; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Recurring installment payment plan for a client (staff view). A plan charges
// a saved method a fixed installment each cycle, applied oldest-first across
// the client's open invoices, until the balance clears. Staff can create, pause,
// resume, cancel, and "run now".

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import type { SavedMethod } from './SavedMethodsCard';

interface Plan {
  id: string;
  paymentMethodId: string;
  frequency: string;
  nextRunDate: string;
  installmentCents: number;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  consecutiveFailureCount: number;
  pausedReason: string | null;
  lastRunAt: string | null;
}

const FREQUENCIES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const;

function fmtCents(c: number): string {
  return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusTone(s: Plan['status']): 'success' | 'warning' | 'neutral' | 'danger' {
  if (s === 'ACTIVE') return 'success';
  if (s === 'PAUSED') return 'warning';
  if (s === 'CANCELLED') return 'danger';
  return 'neutral';
}

export function PaymentPlanCard({
  clientId,
  reloadKey,
}: {
  clientId: string;
  reloadKey?: number;
}): JSX.Element {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [methods, setMethods] = useState<SavedMethod[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([
        api<{ items: Plan[] }>(
          `/api/staff/client-payment-plans?clientId=${encodeURIComponent(clientId)}`,
        ),
        api<{ items: SavedMethod[] }>(
          `/api/staff/payment-methods?clientId=${encodeURIComponent(clientId)}`,
        ),
      ]);
      setPlans(p.items);
      setMethods(m.items);
    } catch {
      setError('Could not load payment plans.');
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const chargeable = methods.filter((m) => m.verificationStatus === null);

  async function action(id: string, verb: string, body?: unknown): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ ok: boolean; outcome?: string; error?: string }>(
        `/api/staff/client-payment-plans/${id}/${verb}`,
        { method: 'POST', body: body ? JSON.stringify(body) : undefined },
      );
      if (verb === 'run-now') {
        setNotice(
          r.outcome === 'charged'
            ? 'Installment charged.'
            : r.outcome === 'completed'
              ? 'Balance cleared — plan completed.'
              : r.outcome === 'requires_action'
                ? 'Charge needs authentication — plan paused.'
                : 'Charge attempted.',
        );
      }
      await load();
    } catch (e) {
      setError(`Could not ${verb.replace('-', ' ')} the plan.`);
    }
  }

  return (
    <Card
      title="Recurring payment plan"
      action={
        !adding && chargeable.length > 0 ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            New plan
          </Button>
        ) : adding ? (
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        ) : undefined
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>{notice}</p>
      )}

      {chargeable.length === 0 && !adding && (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          Add a verified card or bank above first, then you can schedule a recurring plan.
        </p>
      )}

      {adding && (
        <NewPlanForm
          clientId={clientId}
          methods={chargeable}
          onDone={() => {
            setAdding(false);
            setNotice('Payment plan created.');
            void load();
          }}
          onError={setError}
        />
      )}

      {!adding && plans.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          {plans.map((p) => {
            const method = methods.find((m) => m.id === p.paymentMethodId);
            return (
              <div
                key={p.id}
                style={{
                  padding: '10px 12px',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: 8,
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {fmtCents(p.installmentCents)} · {p.frequency.toLowerCase()}
                  </span>
                  <Pill tone={statusTone(p.status)}>{p.status}</Pill>
                </div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  {method ? method.displayLabel : 'method removed'} ·{' '}
                  {p.status === 'ACTIVE'
                    ? `next ${p.nextRunDate}`
                    : `last run ${p.lastRunAt?.slice(0, 10) ?? '—'}`}
                  {p.consecutiveFailureCount > 0 &&
                    ` · ${p.consecutiveFailureCount} recent failure(s)`}
                  {p.pausedReason && ` · ${p.pausedReason}`}
                </div>
                {(p.status === 'ACTIVE' || p.status === 'PAUSED') && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button size="sm" variant="ghost" onClick={() => void action(p.id, 'run-now')}>
                      Run now
                    </Button>
                    {p.status === 'ACTIVE' ? (
                      <Button size="sm" variant="ghost" onClick={() => void action(p.id, 'pause')}>
                        Pause
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => void action(p.id, 'resume')}>
                        Resume
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => void action(p.id, 'cancel')}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!adding && plans.length === 0 && chargeable.length > 0 && (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No plans yet.</p>
      )}
    </Card>
  );
}

function NewPlanForm({
  clientId,
  methods,
  onDone,
  onError,
}: {
  clientId: string;
  methods: SavedMethod[];
  onDone: () => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const [paymentMethodId, setPmId] = useState(methods[0]?.id ?? '');
  const [installmentDollars, setInstallment] = useState('');
  const [frequency, setFrequency] = useState<(typeof FREQUENCIES)[number]>('MONTHLY');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const cents = Math.round(Number(installmentDollars) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      onError('Enter a valid installment amount.');
      return;
    }
    setBusy(true);
    try {
      await api('/api/staff/client-payment-plans', {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          paymentMethodId,
          frequency,
          installmentCents: cents,
          startDate,
          authorizationNote: note || undefined,
        }),
      });
      onDone();
    } catch {
      onError('Could not create the plan.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 10, maxWidth: 460 }}>
      <label style={{ fontSize: 12 }}>
        Charge to
        <select
          value={paymentMethodId}
          onChange={(e) => setPmId(e.target.value)}
          style={{ display: 'block', marginTop: 4, padding: 6, width: '100%' }}
        >
          {methods.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayLabel}
            </option>
          ))}
        </select>
      </label>
      <label style={{ fontSize: 12 }}>
        Installment amount (USD)
        <Input
          value={installmentDollars}
          onChange={(e) => setInstallment(e.target.value.replace(/[^\d.]/g, ''))}
          inputMode="decimal"
          placeholder="e.g. 250.00"
          required
          style={{ width: '100%' }}
        />
      </label>
      <label style={{ fontSize: 12 }}>
        Frequency
        <select
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as (typeof FREQUENCIES)[number])}
          style={{ display: 'block', marginTop: 4, padding: 6, width: '100%' }}
        >
          {FREQUENCIES.map((f) => (
            <option key={f} value={f}>
              {f.charAt(0) + f.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </label>
      <label style={{ fontSize: 12 }}>
        First charge date
        <Input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          required
          style={{ width: '100%' }}
        />
      </label>
      <label style={{ fontSize: 12 }}>
        Authorization note (optional)
        <Input value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%' }} />
      </label>
      <p style={{ fontSize: 11, color: tokens.color.textMuted }}>
        Each cycle charges the installment (capped at the current balance) across open invoices,
        oldest first, until the balance is cleared.
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="submit" disabled={busy || !paymentMethodId}>
          {busy ? 'Creating…' : 'Create plan'}
        </Button>
      </div>
    </form>
  );
}
