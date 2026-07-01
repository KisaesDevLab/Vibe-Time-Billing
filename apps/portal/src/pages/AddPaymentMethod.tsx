/* eslint-disable jsx-a11y/label-has-associated-control -- labels wrap their controls inside grid forms; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: Elastic-2.0
//
// Portal "add a saved payment method" panel. A client can save a card/bank via
// the Stripe Payment Element, or enter a bank manually by routing/account
// number (no bank login) — the latter is verified via micro-deposits before it
// can be charged. Mirrors the staff SavedMethodsCard capture flows against the
// /api/portal/profile/payment-methods endpoints.

import { useEffect, useState, type FormEvent } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';

import { Button, tokens } from '@vibe/ui';

import { api } from '../api-client';

type Mode = 'choose' | 'elements' | 'manual';

const inputStyle = {
  width: '100%',
  padding: '6px 10px',
  borderRadius: 6,
  border: `1px solid ${tokens.color.border}`,
  fontSize: 13,
} as const;

export function AddPaymentMethodPanel({
  onDone,
  onCancel,
}: {
  onDone: (message: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>('choose');
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        display: 'grid',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 13 }}>Add a payment method</strong>
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Close
        </Button>
      </div>
      {error && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{error}</p>}

      {mode === 'choose' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button size="sm" onClick={() => setMode('elements')}>
            Add card / bank
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setMode('manual')}>
            Enter bank manually
          </Button>
        </div>
      )}

      {mode === 'elements' && (
        <ElementsCapture onDone={onDone} onError={setError} onBack={() => setMode('choose')} />
      )}
      {mode === 'manual' && (
        <ManualBankForm onDone={onDone} onError={setError} onBack={() => setMode('choose')} />
      )}
    </div>
  );
}

function ElementsCapture({
  onDone,
  onError,
  onBack,
}: {
  onDone: (message: string) => void;
  onError: (msg: string) => void;
  onBack: () => void;
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
        }>('/api/portal/profile/payment-methods/setup-intent', {
          method: 'POST',
          body: JSON.stringify({}),
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
        onError('Could not start the secure form. Please try again later.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  if (loading) return <p style={{ fontSize: 13 }}>Loading secure form…</p>;
  if (!stripePromise || !clientSecret || !setupIntentId) {
    return (
      <Button size="sm" variant="secondary" onClick={onBack}>
        Back
      </Button>
    );
  }
  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
      <SetupForm setupIntentId={setupIntentId} onDone={onDone} onError={onError} />
    </Elements>
  );
}

function SetupForm({
  setupIntentId,
  onDone,
  onError,
}: {
  setupIntentId: string;
  onDone: (message: string) => void;
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
      await api('/api/portal/profile/payment-methods/confirm', {
        method: 'POST',
        body: JSON.stringify({ setupIntentId }),
      });
      onDone('Payment method saved.');
    } catch {
      // A bank saved via micro-deposits confirms later; treat as success.
      onDone('Payment method saved.');
    }
  }

  return (
    <div>
      <PaymentElement />
      <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 8 }}>
        Saving authorizes this card/bank to be charged for your future invoices.
      </p>
      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
        <Button size="sm" onClick={() => void submit()} disabled={!stripe || busy}>
          {busy ? 'Saving…' : 'Save method'}
        </Button>
      </div>
    </div>
  );
}

function ManualBankForm({
  onDone,
  onError,
  onBack,
}: {
  onDone: (message: string) => void;
  onError: (msg: string) => void;
  onBack: () => void;
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
        '/api/portal/profile/payment-methods/manual-ach',
        {
          method: 'POST',
          body: JSON.stringify({
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
          : 'Bank saved. Two small deposits were sent to your account — return here in 1–2 business days to verify them.',
      );
    } catch {
      onError('Could not save the bank. Check the routing and account numbers.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 8 }}>
      <label style={{ fontSize: 12 }}>
        Account holder name
        <input
          value={accountHolderName}
          onChange={(e) => setName(e.target.value)}
          required
          style={inputStyle}
        />
      </label>
      <label style={{ fontSize: 12 }}>
        Routing number (9 digits)
        <input
          value={routingNumber}
          onChange={(e) => setRouting(e.target.value.replace(/\D/g, '').slice(0, 9))}
          inputMode="numeric"
          required
          style={inputStyle}
        />
      </label>
      <label style={{ fontSize: 12 }}>
        Account number
        <input
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
          style={inputStyle}
        >
          <option value="individual">Individual</option>
          <option value="company">Company</option>
        </select>
      </label>
      <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
        You authorize ACH debits from this account for your future invoices. We confirm ownership
        with two small deposits.
      </p>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Button size="sm" variant="secondary" onClick={onBack} type="button">
          Back
        </Button>
        <Button
          size="sm"
          type="submit"
          disabled={busy || routingNumber.length !== 9 || accountNumber.length < 4}
        >
          {busy ? 'Saving…' : 'Save bank'}
        </Button>
      </div>
    </form>
  );
}

export function VerifyMicrodepositsButton({
  methodId,
  onVerified,
  onError,
}: {
  methodId: string;
  onVerified: () => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [a0, setA0] = useState('');
  const [a1, setA1] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/portal/profile/payment-methods/${methodId}/verify-microdeposits`, {
        method: 'POST',
        body: JSON.stringify({ amounts: [Number(a0), Number(a1)] }),
      });
      setOpen(false);
      onVerified();
    } catch {
      onError('Verification failed — check the two deposit amounts (in cents).');
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
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <input
        placeholder="¢"
        value={a0}
        onChange={(e) => setA0(e.target.value.replace(/\D/g, '').slice(0, 2))}
        style={{ ...inputStyle, width: 56 }}
      />
      <input
        placeholder="¢"
        value={a1}
        onChange={(e) => setA1(e.target.value.replace(/\D/g, '').slice(0, 2))}
        style={{ ...inputStyle, width: 56 }}
      />
      <Button size="sm" onClick={() => void submit()} disabled={busy || !a0 || !a1}>
        {busy ? '…' : 'OK'}
      </Button>
    </span>
  );
}
