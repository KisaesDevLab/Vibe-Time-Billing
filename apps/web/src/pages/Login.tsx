// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { AuthLayout, Button, Input } from '@vibe/ui';

import { api, setCsrfToken } from '../api-client';
import { useAuth } from '../auth-context';

export function LoginPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const tokenFromUrl = searchParams.get('token');
  if (tokenFromUrl) return <VerifyPage token={tokenFromUrl} />;
  return <RequestLinkPage />;
}

function RequestLinkPage(): JSX.Element {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email }) });
      setStatus('sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unexpected error');
      setStatus('idle');
    }
  }

  return (
    <AuthLayout
      brand="Vibe Time & Billing"
      title="Sign in"
      subtitle="We'll email you a single-use sign-in link."
      footer="Staff access requires TOTP. You'll be prompted after the magic link."
    >
      {status === 'sent' ? (
        <p style={{ fontSize: 14 }}>
          If your account exists, a sign-in code has been sent. Check your email.
        </p>
      ) : (
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <Input
            type="email"
            label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
            placeholder="you@firm.example"
          />
          {error && <div style={{ color: '#ef4444', fontSize: 12 }}>{error}</div>}
          <Button type="submit" disabled={status === 'sending' || email.length === 0}>
            {status === 'sending' ? 'Sending…' : 'Send sign-in link'}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

function VerifyPage({ token }: { token: string }): JSX.Element {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function verify(): Promise<void> {
    setSubmitting(true);
    try {
      const res = await api<{ csrfToken: string; needsTotpEnrollment: boolean }>(
        '/api/auth/verify-magic-link',
        { method: 'POST', body: JSON.stringify({ token }) },
      );
      setCsrfToken(res.csrfToken);
      await refresh();
      setDone(true);
      navigate(res.needsTotpEnrollment ? '/auth/totp' : '/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'verification failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout brand="Vibe Time & Billing" title="Confirm sign-in">
      {done ? (
        <p style={{ fontSize: 14 }}>Signed in. Redirecting…</p>
      ) : (
        <>
          <p style={{ fontSize: 14 }}>Click the button to complete sign-in.</p>
          <Button onClick={verify} disabled={submitting}>
            {submitting ? 'Verifying…' : 'Continue'}
          </Button>
          {error && <p style={{ color: '#ef4444', fontSize: 12 }}>{error}</p>}
        </>
      )}
    </AuthLayout>
  );
}
