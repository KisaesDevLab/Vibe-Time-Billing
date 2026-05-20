// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { AuthLayout, Button, Input } from '@vibe/ui';

import { api, setCsrfToken } from '../api-client';
import { useAuth } from '../auth-context';

const AT = '@';

export function LoginPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const tokenFromUrl = searchParams.get('token');
  if (tokenFromUrl) return <VerifyMagic token={tokenFromUrl} />;
  return <CombinedLogin />;
}

function CombinedLogin(): JSX.Element {
  const [contact, setContact] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent_email' | 'sent_sms'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [otpPhone, setOtpPhone] = useState('');

  const looksLikeEmail = contact.includes(AT);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    try {
      await api('/api/portal/auth/login', {
        method: 'POST',
        body: JSON.stringify({ contact }),
      });
      if (looksLikeEmail) {
        setStatus('sent_email');
      } else {
        setOtpPhone(contact);
        setStatus('sent_sms');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unexpected error');
      setStatus('idle');
    }
  }

  if (status === 'sent_email') {
    return (
      <AuthLayout brand="Client Portal" title="Check your email">
        <p style={{ fontSize: 14 }}>
          If your account exists, a sign-in link has been sent. The link is valid for 15 minutes.
        </p>
      </AuthLayout>
    );
  }

  if (status === 'sent_sms') {
    return <SmsOtpForm phone={otpPhone} />;
  }

  return (
    <AuthLayout
      brand="Client Portal"
      title="Sign in"
      subtitle="Enter your email or mobile phone — we'll detect which."
      footer="One person, multiple entities — your accesses live behind a single sign-in."
    >
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Input
          label="Email or phone"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          autoFocus
          required
          placeholder={looksLikeEmail ? `you${AT}example.com` : '(312) 555-0148'}
        />
        {error && <div style={{ color: '#ef4444', fontSize: 12 }}>{error}</div>}
        <Button type="submit" disabled={status === 'sending' || contact.length === 0}>
          {status === 'sending'
            ? 'Sending…'
            : looksLikeEmail
              ? 'Email me a link'
              : 'Text me a code'}
        </Button>
      </form>
    </AuthLayout>
  );
}

function SmsOtpForm({ phone }: { phone: string }): JSX.Element {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<{ csrfToken: string }>('/api/portal/auth/verify-sms-otp', {
        method: 'POST',
        body: JSON.stringify({ phone, code }),
      });
      setCsrfToken(res.csrfToken);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'verification failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout brand="Client Portal" title="Enter your code" subtitle={`Sent to ${phone}`}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Input
          label="6-digit code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          autoFocus
          required
          maxLength={6}
        />
        {error && <div style={{ color: '#ef4444', fontSize: 12 }}>{error}</div>}
        <Button type="submit" disabled={submitting || code.length !== 6}>
          {submitting ? 'Verifying…' : 'Verify'}
        </Button>
      </form>
    </AuthLayout>
  );
}

function VerifyMagic({ token }: { token: string }): JSX.Element {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function verify(): Promise<void> {
    setSubmitting(true);
    try {
      const res = await api<{ csrfToken: string }>('/api/portal/auth/verify-magic-link', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      setCsrfToken(res.csrfToken);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'verification failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout brand="Client Portal" title="Confirm sign-in">
      <p style={{ fontSize: 14 }}>Tap continue to complete sign-in.</p>
      <Button onClick={verify} disabled={submitting}>
        {submitting ? 'Verifying…' : 'Continue'}
      </Button>
      {error && <p style={{ color: '#ef4444', fontSize: 12 }}>{error}</p>}
    </AuthLayout>
  );
}
