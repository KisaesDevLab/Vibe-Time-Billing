// SPDX-License-Identifier: Elastic-2.0
//
// Public self-service "request portal access" page. A visitor enters their
// email/phone and a verification id (last-4 SSN or entity EIN); the firm
// reviews and grants access. The API is enumeration-safe — it always
// returns the same generic acknowledgement — so this page shows the same
// confirmation regardless of whether the contact matched.

import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { AuthLayout, Button, Input, tokens } from '@vibe/ui';

import { api } from '../api-client';

type IdType = 'SSN_LAST4' | 'EIN';

export function RequestAccessPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const [contact, setContact] = useState(searchParams.get('contact') ?? '');
  const [idType, setIdType] = useState<IdType>('SSN_LAST4');
  const [idValue, setIdValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const idOk = /^\d{4}$/.test(idValue);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    try {
      await api('/api/portal/access-request', {
        method: 'POST',
        body: JSON.stringify({ contact: contact.trim(), idType, idValue: idValue.trim() }),
      });
      setStatus('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'request_failed';
      setError(
        msg === 'invalid_id'
          ? idType === 'SSN_LAST4'
            ? 'Enter the last 4 digits of your SSN.'
            : 'Enter the last 4 digits of your EIN.'
          : 'Something went wrong. Please try again.',
      );
      setStatus('idle');
    }
  }

  if (status === 'done') {
    return (
      <AuthLayout brand="Client Portal" title="Request received">
        <p style={{ fontSize: 14 }}>
          Thanks — if your information matches our records, we&apos;ll review your request and
          follow up by email or text once access is granted.
        </p>
        <p style={{ fontSize: 13, marginTop: 12 }}>
          <Link to="/auth/login" style={{ color: tokens.color.accent }}>
            Back to sign in
          </Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      brand="Client Portal"
      title="Request access"
      subtitle="Tell us who you are and we'll set up your portal access."
    >
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Input
          label="Email or phone"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          required
          placeholder="you@example.com or (312) 555-0148"
        />

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Verify your identity</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <ChoiceButton
              active={idType === 'SSN_LAST4'}
              onClick={() => {
                setIdType('SSN_LAST4');
                setIdValue('');
              }}
            >
              Individual
            </ChoiceButton>
            <ChoiceButton
              active={idType === 'EIN'}
              onClick={() => {
                setIdType('EIN');
                setIdValue('');
              }}
            >
              Business
            </ChoiceButton>
          </div>
        </div>

        <Input
          label={idType === 'SSN_LAST4' ? 'Last 4 digits of SSN' : 'Last 4 digits of EIN'}
          value={idValue}
          onChange={(e) => setIdValue(e.target.value.replace(/\D/g, '').slice(0, 4))}
          inputMode="numeric"
          required
          maxLength={4}
          placeholder="1234"
        />

        {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}

        <Button type="submit" disabled={status === 'sending' || contact.length < 3 || !idOk}>
          {status === 'sending' ? 'Submitting…' : 'Request access'}
        </Button>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, textAlign: 'center', margin: 0 }}>
          Already have access?{' '}
          <Link to="/auth/login" style={{ color: tokens.color.accent }}>
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

function ChoiceButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        padding: '8px 10px',
        fontSize: 13,
        cursor: 'pointer',
        borderRadius: tokens.radius.sm,
        border: `1px solid ${active ? tokens.color.accent : tokens.color.border}`,
        background: active ? tokens.color.accent : 'transparent',
        color: active ? '#fff' : tokens.color.text,
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}
