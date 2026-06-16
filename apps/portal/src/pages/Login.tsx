// SPDX-License-Identifier: Elastic-2.0
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { AuthLayout, Button, Input, tokens } from '@vibe/ui';

import { api, setCsrfToken } from '../api-client';
import { useAuth } from '../auth-context';

const AT = '@';

// Firm logo on the auth screens. Reads the public branding endpoint (no auth);
// renders nothing when no logo is uploaded (the endpoint 404s).
function BrandLogo(): JSX.Element | null {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <img
      src="/api/portal/branding/logo"
      alt=""
      onError={() => setOk(false)}
      style={{ maxHeight: 48, maxWidth: 200, objectFit: 'contain', display: 'block' }}
    />
  );
}

export function LoginPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const tokenFromUrl = searchParams.get('token');
  if (tokenFromUrl) return <VerifyMagic token={tokenFromUrl} />;
  return <CombinedLogin />;
}

function CombinedLogin(): JSX.Element {
  const navigate = useNavigate();
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
      const r = await api<{ access?: boolean }>('/api/portal/auth/login', {
        method: 'POST',
        body: JSON.stringify({ contact }),
      });
      // No active portal access for this contact → send them to request it,
      // pre-filling what they typed.
      if (!r.access) {
        navigate(`/auth/request-access?contact=${encodeURIComponent(contact.trim())}`);
        return;
      }
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
      <AuthLayout brand="Client Portal" logo={<BrandLogo />} title="Check your email">
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
      logo={<BrandLogo />}
      title="Sign in"
      subtitle="Enter your email or mobile phone — we'll detect which."
      footer="One person, multiple entities — your accesses live behind a single sign-in."
    >
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Input
          label="Email or phone"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          required
          placeholder={looksLikeEmail ? `you${AT}example.com` : '(312) 555-0148'}
        />
        {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}
        <Button type="submit" disabled={status === 'sending' || contact.length === 0}>
          {status === 'sending'
            ? 'Sending…'
            : looksLikeEmail
              ? 'Email me a link'
              : 'Text me a code'}
        </Button>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, textAlign: 'center', margin: 0 }}>
          Don&apos;t have access yet?{' '}
          <Link to="/auth/request-access" style={{ color: tokens.color.accent }}>
            Request access
          </Link>
        </p>
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
    <AuthLayout
      brand="Client Portal"
      logo={<BrandLogo />}
      title="Enter your code"
      subtitle={`Sent to ${phone}`}
    >
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Input
          label="6-digit code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          required
          maxLength={6}
        />
        {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}
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
  // Q6 — when the firm doesn't recognize this device, the server sends an
  // SMS code and asks us to verify it before completing sign-in.
  const [challenge, setChallenge] = useState<{ token: string; phoneHint: string } | null>(null);

  async function verify(): Promise<void> {
    setSubmitting(true);
    try {
      const res = await api<{
        csrfToken?: string;
        deviceChallenge?: boolean;
        challengeToken?: string;
        phoneHint?: string;
      }>('/api/portal/auth/verify-magic-link', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      if (res.deviceChallenge && res.challengeToken) {
        setChallenge({ token: res.challengeToken, phoneHint: res.phoneHint ?? '••••' });
        return;
      }
      if (res.csrfToken) setCsrfToken(res.csrfToken);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'verification failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (challenge) {
    return <DeviceOtpForm challengeToken={challenge.token} phoneHint={challenge.phoneHint} />;
  }

  return (
    <AuthLayout brand="Client Portal" logo={<BrandLogo />} title="Confirm sign-in">
      <p style={{ fontSize: 14 }}>Tap continue to complete sign-in.</p>
      <Button onClick={verify} disabled={submitting}>
        {submitting ? 'Verifying…' : 'Continue'}
      </Button>
      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </AuthLayout>
  );
}

// Q6 — verify a code sent to the phone on file to trust a new device.
function DeviceOtpForm({
  challengeToken,
  phoneHint,
}: {
  challengeToken: string;
  phoneHint: string;
}): JSX.Element {
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
      const res = await api<{ csrfToken: string }>('/api/portal/auth/verify-device-otp', {
        method: 'POST',
        body: JSON.stringify({ challengeToken, code }),
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
    <AuthLayout
      brand="Client Portal"
      logo={<BrandLogo />}
      title="Verify this device"
      subtitle={`For your security, enter the code we texted to the number ending in ${phoneHint}.`}
    >
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <Input
          label="6-digit code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          required
          maxLength={6}
        />
        {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}
        <Button type="submit" disabled={submitting || code.length !== 6}>
          {submitting ? 'Verifying…' : 'Verify device'}
        </Button>
      </form>
    </AuthLayout>
  );
}
