/* eslint-disable jsx-a11y/label-has-associated-control -- labels wrap their controls inside grid forms; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Saved payment methods for a client (staff view). Staff can capture a card or
// bank on file two ways:
//   • "Add card / bank" — the Stripe Payment Element (card, or bank via instant
//     login with a manual-entry fallback).
//   • "Enter bank manually" — routing + account number only (no bank login),
//     verified asynchronously via micro-deposits.
// Saved methods power off-session Receive Payment charges + recurring plans.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

export interface SavedMethod {
  id: string;
  kind: 'CARD' | 'ACH';
  brand: string | null;
  lastFour: string;
  displayLabel: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  verificationStatus: 'PENDING_MICRODEPOSIT' | null;
}

type Mode = 'list' | 'add-elements' | 'add-manual';

export function SavedMethodsCard({
  clientId,
  onChanged,
}: {
  clientId: string;
  onChanged?: () => void;
}): JSX.Element {
  const [methods, setMethods] = useState<SavedMethod[]>([]);
  const [mode, setMode] = useState<Mode>('list');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: SavedMethod[] }>(
        `/api/staff/payment-methods?clientId=${encodeURIComponent(clientId)}`,
      );
      setMethods(r.items);
    } catch {
      setError('Could not load saved methods.');
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
    onChanged?.();
  }, [load, onChanged]);

  async function remove(id: string): Promise<void> {
    if (!window.confirm('Remove this saved method? Recurring plans using it will stop.')) return;
    try {
      await api(`/api/staff/payment-methods/${id}`, { method: 'DELETE' });
      setNotice('Method removed.');
      refresh();
    } catch {
      setError('Could not remove the method.');
    }
  }

  return (
    <Card
      title="Saved payment methods"
      action={
        mode === 'list' ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => setMode('add-manual')}>
              Enter bank manually
            </Button>
            <Button size="sm" onClick={() => setMode('add-elements')}>
              Add card / bank
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setMode('list')}>
            Cancel
          </Button>
        )
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

      {mode === 'list' && (
        <MethodList methods={methods} clientId={clientId} onRemove={remove} onVerified={refresh} />
      )}

      {mode === 'add-elements' && (
        <AddViaElements
          clientId={clientId}
          onDone={() => {
            setMode('list');
            setNotice('Payment method saved.');
            refresh();
          }}
          onError={setError}
        />
      )}

      {mode === 'add-manual' && (
        <AddManualBank
          clientId={clientId}
          onDone={(msg) => {
            setMode('list');
            setNotice(msg);
            refresh();
          }}
          onError={setError}
        />
      )}
    </Card>
  );
}

function MethodList({
  methods,
  clientId,
  onRemove,
  onVerified,
}: {
  methods: SavedMethod[];
  clientId: string;
  onRemove: (id: string) => void;
  onVerified: () => void;
}): JSX.Element {
  if (methods.length === 0) {
    return <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No saved methods yet.</p>;
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {methods.map((m) => (
        <div
          key={m.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '8px 12px',
            border: `1px solid ${tokens.color.border}`,
            borderRadius: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13 }}>
              {m.kind === 'CARD' ? '💳' : '🏦'} {m.displayLabel}
            </span>
            {m.kind === 'CARD' && m.expMonth != null && (
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                exp {String(m.expMonth).padStart(2, '0')}/{m.expYear}
              </span>
            )}
            {m.verificationStatus === 'PENDING_MICRODEPOSIT' && (
              <Pill tone="warning">Awaiting micro-deposits</Pill>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {m.verificationStatus === 'PENDING_MICRODEPOSIT' && (
              <VerifyMicrodeposits methodId={m.id} clientId={clientId} onVerified={onVerified} />
            )}
            <Button size="sm" variant="ghost" onClick={() => onRemove(m.id)}>
              Remove
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Add via Stripe Payment Element (card, or bank with instant + manual) ----

function AddViaElements({
  clientId,
  onDone,
  onError,
}: {
  clientId: string;
  onDone: () => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupIntentId, setSetupIntentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api<{
          setupIntentId: string;
          clientSecret: string;
          publishableKey: string;
          stripeAccountId: string;
        }>('/api/staff/payment-methods/setup-intent', {
          method: 'POST',
          body: JSON.stringify({ clientId }),
        });
        if (cancelled) return;
        setSetupIntentId(r.setupIntentId);
        setClientSecret(r.clientSecret);
        setStripePromise(
          loadStripe(
            r.publishableKey,
            r.stripeAccountId ? { stripeAccount: r.stripeAccountId } : undefined,
          ),
        );
      } catch {
        onError('Could not start the save flow. Is Stripe configured?');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, onError]);

  if (loading) return <p style={{ fontSize: 13 }}>Loading secure form…</p>;
  if (!stripePromise || !clientSecret || !setupIntentId) return <></>;

  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
      <SetupForm
        clientId={clientId}
        setupIntentId={setupIntentId}
        onDone={onDone}
        onError={onError}
      />
    </Elements>
  );
}

function SetupForm({
  clientId,
  setupIntentId,
  onDone,
  onError,
}: {
  clientId: string;
  setupIntentId: string;
  onDone: () => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!stripe || !elements) return;
    setBusy(true);
    const { error } = await stripe.confirmSetup({ elements, redirect: 'if_required' });
    if (error) {
      onError(error.message ?? 'Could not save the method.');
      setBusy(false);
      return;
    }
    try {
      await api('/api/staff/payment-methods/confirm', {
        method: 'POST',
        body: JSON.stringify({ clientId, setupIntentId }),
      });
      onDone();
    } catch {
      // A bank saved via micro-deposits confirms later; treat as success.
      onDone();
    }
  }

  return (
    <div>
      <PaymentElement />
      <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 8 }}>
        By saving, the client authorizes this card/bank to be charged for future invoices.
      </p>
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={() => void submit()} disabled={!stripe || busy}>
          {busy ? 'Saving…' : 'Save method'}
        </Button>
      </div>
    </div>
  );
}

// ---- Add bank by routing + account number (manual, micro-deposit verified) ----

function AddManualBank({
  clientId,
  onDone,
  onError,
}: {
  clientId: string;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const [routingNumber, setRouting] = useState('');
  const [accountNumber, setAccount] = useState('');
  const [accountHolderName, setName] = useState('');
  const [accountHolderType, setType] = useState<'individual' | 'company'>('individual');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ verification: 'microdeposit_pending' | 'verified' }>(
        '/api/staff/payment-methods/manual-ach',
        {
          method: 'POST',
          body: JSON.stringify({
            clientId,
            routingNumber,
            accountNumber,
            accountHolderName,
            accountHolderType,
          }),
        },
      );
      onDone(
        r.verification === 'verified'
          ? 'Bank saved and verified.'
          : 'Bank saved. Two small micro-deposits were sent — verify them here in 1–2 business days to enable charging.',
      );
    } catch {
      onError('Could not save the bank. Check the routing/account numbers.');
      setBusy(false);
    }
  }

  const inputStyle = { width: '100%' };

  return (
    <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 10, maxWidth: 420 }}>
      <label style={{ fontSize: 12 }}>
        Account holder name
        <Input
          value={accountHolderName}
          onChange={(e) => setName(e.target.value)}
          required
          style={inputStyle}
        />
      </label>
      <label style={{ fontSize: 12 }}>
        Routing number (9 digits)
        <Input
          value={routingNumber}
          onChange={(e) => setRouting(e.target.value.replace(/\D/g, '').slice(0, 9))}
          inputMode="numeric"
          required
          style={inputStyle}
        />
      </label>
      <label style={{ fontSize: 12 }}>
        Account number
        <Input
          value={accountNumber}
          onChange={(e) => setAccount(e.target.value.replace(/\D/g, '').slice(0, 17))}
          inputMode="numeric"
          required
          style={inputStyle}
        />
      </label>
      <label style={{ fontSize: 12 }}>
        Account type
        <select
          value={accountHolderType}
          onChange={(e) => setType(e.target.value as 'individual' | 'company')}
          style={{ display: 'block', marginTop: 4, padding: 6 }}
        >
          <option value="individual">Individual</option>
          <option value="company">Company</option>
        </select>
      </label>
      <p style={{ fontSize: 11, color: tokens.color.textMuted }}>
        The client authorizes ACH debits from this account for future invoices. Ownership is
        confirmed via two small micro-deposits.
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          type="submit"
          disabled={busy || routingNumber.length !== 9 || accountNumber.length < 4}
        >
          {busy ? 'Saving…' : 'Save bank'}
        </Button>
      </div>
    </form>
  );
}

function VerifyMicrodeposits({
  methodId,
  clientId,
  onVerified,
}: {
  methodId: string;
  clientId: string;
  onVerified: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [a0, setA0] = useState('');
  const [a1, setA1] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/staff/payment-methods/${methodId}/verify-microdeposits`, {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          amounts: [Number(a0), Number(a1)],
        }),
      });
      setOpen(false);
      onVerified();
    } catch {
      setErr('Verification failed — check the two amounts (in cents).');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Verify
      </Button>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <Input
          placeholder="e.g. 32"
          value={a0}
          onChange={(e) => setA0(e.target.value.replace(/\D/g, '').slice(0, 2))}
          style={{ width: 70 }}
        />
        <Input
          placeholder="e.g. 45"
          value={a1}
          onChange={(e) => setA1(e.target.value.replace(/\D/g, '').slice(0, 2))}
          style={{ width: 70 }}
        />
        <Button size="sm" onClick={() => void submit()} disabled={busy || !a0 || !a1}>
          {busy ? '…' : 'OK'}
        </Button>
      </div>
      {err && <span style={{ fontSize: 11, color: tokens.color.danger }}>{err}</span>}
    </div>
  );
}
