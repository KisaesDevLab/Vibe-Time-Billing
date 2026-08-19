// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff sign-in. Three methods live side-by-side (0087 + passkey login):
//   - Magic link → 2FA → session
//   - Password   → 2FA factor pick (TOTP / email / SMS / passkey) → session
//   - Passkey    → discoverable-credential flow → session (passwordless)
//
// The verify-via-link path still works when the URL carries ?token=,
// so existing emailed magic links open the right screen automatically.

import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/browser';

import { AuthLayout, Button, Input, tokens } from '@vibe/ui';

import { api, setCsrfToken } from '../api-client';
import { useAuth } from '../auth-context';
import { BRAND } from '../brand';

type Factor = 'TOTP' | 'EMAIL' | 'SMS' | 'PASSKEY';

export function LoginPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const { pathname } = useLocation();
  const tokenFromUrl = searchParams.get('token');
  // /auth/reset-password?token=… — emailed "forgot password" link. Its
  // token can only set a new password (distinct audience), never sign in.
  if (pathname.endsWith('/reset-password')) return <ResetPasswordPage token={tokenFromUrl} />;
  if (tokenFromUrl) return <VerifyPage token={tokenFromUrl} />;
  return <SignInPage />;
}

function SignInPage(): JSX.Element {
  const [method, setMethod] = useState<'magic' | 'password' | 'passkey'>('magic');
  return (
    <AuthLayout
      brand={BRAND}
      title="Sign in"
      subtitle={
        method === 'magic'
          ? "We'll email you a single-use sign-in link."
          : method === 'password'
            ? 'Use your password + second factor.'
            : 'Use a passkey saved on this device.'
      }
      footer={
        method === 'magic'
          ? 'After your link is verified, you may also be asked for your second factor.'
          : method === 'password'
            ? "Don't have a password yet? Use the magic-link option and set one from your profile."
            : 'No passkey yet? Sign in via magic link or password, then add one from your profile.'
      }
    >
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        <Button
          size="sm"
          variant={method === 'magic' ? 'primary' : 'secondary'}
          onClick={() => setMethod('magic')}
        >
          Magic link
        </Button>
        <Button
          size="sm"
          variant={method === 'password' ? 'primary' : 'secondary'}
          onClick={() => setMethod('password')}
        >
          Password
        </Button>
        <Button
          size="sm"
          variant={method === 'passkey' ? 'primary' : 'secondary'}
          onClick={() => setMethod('passkey')}
        >
          Passkey
        </Button>
      </div>
      {method === 'magic' && <MagicLinkForm />}
      {method === 'password' && <PasswordFlow />}
      {method === 'passkey' && <PasskeyFlow />}
    </AuthLayout>
  );
}

function PasskeyFlow(): JSX.Element {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      // 1. Ask the server for a challenge. allowCredentials is empty so
      //    the browser shows the user every passkey it has for this site
      //    (discoverable credentials).
      const opts = await api<{
        options: PublicKeyCredentialRequestOptionsJSON;
        nonce: string;
      }>('/api/auth/login/passkey/options', { method: 'POST', body: JSON.stringify({}) });
      // 2. Hand the challenge to the platform authenticator. The user
      //    picks a credential and biometric-verifies. Errors here are
      //    typically NotAllowedError if the user cancels.
      const response = await startAuthentication({ optionsJSON: opts.options });
      // 3. Send the assertion back. Server looks up the credential by
      //    its globally-unique id, verifies, and creates the session.
      const verify = await api<{ csrfToken: string }>('/api/auth/login/passkey/verify', {
        method: 'POST',
        body: JSON.stringify({ nonce: opts.nonce, response }),
      });
      setCsrfToken(verify.csrfToken);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(humanizeAuthError(err instanceof Error ? err.message : 'failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
        Your browser will prompt you to pick a passkey and verify with your device&apos;s biometric
        or PIN. No email or password needed.
      </p>
      {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}
      <Button onClick={() => void signIn()} disabled={submitting}>
        {submitting ? 'Waiting on device…' : 'Use a passkey'}
      </Button>
    </div>
  );
}

function MagicLinkForm(): JSX.Element {
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

  if (status === 'sent') {
    return (
      <p style={{ fontSize: 14 }}>
        If your account exists, a sign-in code has been sent. Check your email.
      </p>
    );
  }
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
      <Input
        type="email"
        label="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        placeholder="you@firm.example"
      />
      {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}
      <Button type="submit" disabled={status === 'sending' || email.length === 0}>
        {status === 'sending' ? 'Sending…' : 'Send sign-in link'}
      </Button>
    </form>
  );
}

interface PendingState {
  pendingToken: string;
  availableFactors: Factor[];
  preferredFactor: Factor | null;
}

function PasswordFlow(): JSX.Element {
  const [pending, setPending] = useState<PendingState | null>(null);
  const [forgot, setForgot] = useState(false);
  if (pending) return <FactorChallenge pending={pending} reset={() => setPending(null)} />;
  if (forgot) return <ForgotPasswordForm onBack={() => setForgot(false)} />;
  return <PasswordForm onPending={setPending} onForgot={() => setForgot(true)} />;
}

const linkButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: tokens.color.accent,
  fontSize: 12,
  cursor: 'pointer',
  textDecoration: 'underline',
  justifySelf: 'start',
};

// "Forgot password?" — emails a single-use reset link. Same
// no-enumeration contract as the magic-link request: the response is
// identical whether or not the address belongs to a staff account.
function ForgotPasswordForm({ onBack }: { onBack: () => void }): JSX.Element {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    try {
      await api('/api/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email }) });
      setStatus('sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unexpected error');
      setStatus('idle');
    }
  }

  if (status === 'sent') {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <p style={{ fontSize: 14, margin: 0 }}>
          If your account exists, a password reset link has been sent. Check your email — the link
          works once and expires shortly.
        </p>
        <button type="button" style={linkButtonStyle} onClick={onBack}>
          Back to sign in
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
        Enter your email and we&apos;ll send you a link to choose a new password.
      </p>
      <Input
        type="email"
        label="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        placeholder="you@firm.example"
        autoComplete="username"
      />
      {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}
      <Button type="submit" disabled={status === 'sending' || email.length === 0}>
        {status === 'sending' ? 'Sending…' : 'Send reset link'}
      </Button>
      <button type="button" style={linkButtonStyle} onClick={onBack}>
        Back to sign in
      </button>
    </form>
  );
}

function PasswordForm({
  onPending,
  onForgot,
}: {
  onPending: (p: PendingState) => void;
  onForgot: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await api<PendingState | { ok: true; csrfToken: string }>(
        '/api/auth/login/password',
        {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        },
      );
      // 0151 — when the firm has switched the second-factor requirement
      // off, the password alone completes sign-in (no pending token).
      if ('csrfToken' in r) {
        setCsrfToken(r.csrfToken);
        await refresh();
        navigate('/', { replace: true });
        return;
      }
      onPending(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'sign-in failed';
      setError(humanizeAuthError(msg));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
      <Input
        type="email"
        label="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        placeholder="you@firm.example"
      />
      <Input
        type="password"
        label="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        autoComplete="current-password"
      />
      {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}
      <Button type="submit" disabled={submitting || !email || !password}>
        {submitting ? 'Signing in…' : 'Continue'}
      </Button>
      <button type="button" style={linkButtonStyle} onClick={onForgot}>
        Forgot password?
      </button>
    </form>
  );
}

function FactorChallenge({
  pending,
  reset,
}: {
  pending: PendingState;
  reset: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [factor, setFactor] = useState<Factor>(
    pending.preferredFactor ?? pending.availableFactors[0]!,
  );
  const [started, setStarted] = useState(factor === 'TOTP');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [passkeyOptions, setPasskeyOptions] =
    useState<PublicKeyCredentialRequestOptionsJSON | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-start the initial factor on mount. EMAIL/SMS need a send before
  // the code field appears; without this, a user with a single non-TOTP
  // factor lands on a blank screen (the factor picker only renders when
  // there are 2+ options). TOTP/PASSKEY are excluded — TOTP already shows
  // its input, PASSKEY waits for an explicit tap.
  useEffect(() => {
    if (!started && factor !== 'PASSKEY' && factor !== 'TOTP') {
      void start(factor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start(picked: Factor): Promise<void> {
    setFactor(picked);
    setError(null);
    setCode('');
    setPasskeyOptions(null);
    if (picked === 'TOTP') {
      setStarted(true);
      setSentTo(null);
      return;
    }
    setSubmitting(true);
    try {
      const r = await api<{
        ok: boolean;
        sentTo?: string;
        options?: PublicKeyCredentialRequestOptionsJSON;
      }>('/api/auth/2fa/start', {
        method: 'POST',
        body: JSON.stringify({ pendingToken: pending.pendingToken, factor: picked }),
      });
      setStarted(true);
      setSentTo(r.sentTo ?? null);
      if (picked === 'PASSKEY' && r.options) {
        setPasskeyOptions(r.options);
      }
    } catch (err) {
      setError(humanizeAuthError(err instanceof Error ? err.message : 'send failed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function verify(e: FormEvent): Promise<void> {
    e.preventDefault();
    await runVerify();
  }

  async function runVerify(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      let body: Record<string, unknown>;
      if (factor === 'PASSKEY') {
        if (!passkeyOptions) {
          setError('Passkey challenge not ready — pick "Passkey" again.');
          return;
        }
        const response: AuthenticationResponseJSON = await startAuthentication({
          optionsJSON: passkeyOptions,
        });
        body = {
          pendingToken: pending.pendingToken,
          factor: 'PASSKEY',
          response,
        };
      } else {
        body = {
          pendingToken: pending.pendingToken,
          factor,
          code: code.trim(),
        };
      }
      const r = await api<{ csrfToken: string }>('/api/auth/2fa/verify', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setCsrfToken(r.csrfToken);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(humanizeAuthError(err instanceof Error ? err.message : 'verify failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {pending.availableFactors.length > 1 && (
        <div>
          <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
            Choose your second factor
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {pending.availableFactors.map((f) => (
              <Button
                key={f}
                size="sm"
                variant={factor === f ? 'primary' : 'secondary'}
                onClick={() => void start(f)}
                disabled={submitting}
              >
                {factorLabel(f)}
              </Button>
            ))}
          </div>
        </div>
      )}
      {started && factor === 'PASSKEY' && (
        <div style={{ display: 'grid', gap: 12 }}>
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            Tap the button below and your browser will prompt you to verify with your passkey.
          </p>
          {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => void runVerify()} disabled={submitting || !passkeyOptions}>
              {submitting ? 'Waiting on device…' : 'Use passkey'}
            </Button>
            <Button type="button" variant="ghost" onClick={reset} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {started && factor !== 'PASSKEY' && (
        <form onSubmit={verify} style={{ display: 'grid', gap: 12 }}>
          {factor !== 'TOTP' && sentTo && (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
              Code sent to {sentTo}.
            </p>
          )}
          {factor === 'TOTP' && (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
              Open your authenticator app and enter the current code.
            </p>
          )}
          <Input
            type="text"
            label="Verification code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />
          {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="submit" disabled={submitting || code.trim().length < 6}>
              {submitting ? 'Verifying…' : 'Sign in'}
            </Button>
            <Button type="button" variant="ghost" onClick={reset} disabled={submitting}>
              Cancel
            </Button>
            {factor !== 'TOTP' && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void start(factor)}
                disabled={submitting}
              >
                Resend
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function factorLabel(f: Factor): string {
  switch (f) {
    case 'TOTP':
      return 'Authenticator app';
    case 'EMAIL':
      return 'Email code';
    case 'SMS':
      return 'Text message';
    case 'PASSKEY':
      return 'Passkey';
  }
}

function humanizeAuthError(raw: string): string {
  if (raw.includes('invalid_credentials')) return 'Email or password is incorrect.';
  if (raw.includes('no_factor_enrolled')) {
    return 'No second factor is set up on this account. Sign in via magic link and add one from your profile.';
  }
  if (raw.includes('rate_limited')) {
    return 'Too many attempts. Try again in a few minutes.';
  }
  if (raw.includes('locked_out')) {
    return 'Account is temporarily locked after too many failed codes. Try again in 15 minutes.';
  }
  if (raw.includes('invalid_code')) return 'That code is incorrect.';
  if (raw.includes('invalid_pending_token')) {
    return 'Sign-in session expired. Please start over.';
  }
  if (raw.includes('otp_expired_or_missing')) {
    return 'Your code expired. Send a new one.';
  }
  return raw;
}

function VerifyPage({ token }: { token: string }): JSX.Element {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  // When the firm requires a second factor and one is enrolled, the
  // magic-link verify returns a pending token instead of a session — we
  // hand it to the same FactorChallenge UI the password path uses.
  const [pending, setPending] = useState<PendingState | null>(null);

  async function verify(): Promise<void> {
    setSubmitting(true);
    try {
      const res = await api<
        | ({ needsSecondFactor: true } & PendingState)
        | {
            ok: true;
            csrfToken: string;
            needsTotpEnrollment: boolean;
            needsFactorEnrollment?: boolean;
          }
      >('/api/auth/verify-magic-link', { method: 'POST', body: JSON.stringify({ token }) });
      if (!('ok' in res)) {
        setPending({
          pendingToken: res.pendingToken,
          availableFactors: res.availableFactors,
          preferredFactor: res.preferredFactor,
        });
        return;
      }
      setCsrfToken(res.csrfToken);
      await refresh();
      setDone(true);
      navigate(res.needsTotpEnrollment || res.needsFactorEnrollment ? '/auth/totp' : '/', {
        replace: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'verification failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (pending) {
    return (
      <AuthLayout brand={BRAND} title="Confirm sign-in">
        <FactorChallenge pending={pending} reset={() => setPending(null)} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout brand={BRAND} title="Confirm sign-in">
      {done ? (
        <p style={{ fontSize: 14 }}>Signed in. Redirecting…</p>
      ) : (
        <>
          <p style={{ fontSize: 14 }}>Click the button to complete sign-in.</p>
          <Button onClick={verify} disabled={submitting}>
            {submitting ? 'Verifying…' : 'Continue'}
          </Button>
          {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        </>
      )}
    </AuthLayout>
  );
}

// ---------------------------------------------------------------------
// /auth/reset-password?token=… — choose a new password from an emailed
// reset link. On success the user signs in normally (password + second
// factor); the reset itself never creates a session.
// ---------------------------------------------------------------------

const MIN_PASSWORD_LENGTH = 12;

function humanizeResetError(raw: string, reason?: string): string {
  if (raw === 'invalid_token' || raw === 'token_already_used')
    return 'This reset link is invalid, expired, or has already been used. Request a new one from the sign-in page.';
  if (raw === 'password_policy') {
    if (reason === 'too_short')
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (reason === 'too_long') return 'Password is too long (256 characters max).';
    if (reason === 'whitespace_only') return 'Password cannot be blank.';
    return 'Password does not meet the policy.';
  }
  if (raw === 'unknown_user') return 'This account no longer exists.';
  return raw;
}

function ResetPasswordPage({ token }: { token: string | null }): JSX.Element {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && confirm !== password;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!token || mismatch) return;
    setSubmitting(true);
    setError(null);
    try {
      await api('/api/auth/password/reset', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword: password }),
      });
      setDone(true);
    } catch (err) {
      const body = (err as { body?: { error?: string; reason?: string } }).body;
      const msg = err instanceof Error ? err.message : 'reset failed';
      setError(humanizeResetError(body?.error ?? msg, body?.reason));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      brand={BRAND}
      title="Choose a new password"
      subtitle={
        done ? 'Your password has been updated.' : `At least ${MIN_PASSWORD_LENGTH} characters.`
      }
      footer="Reset links work once and expire shortly. Any existing sessions on this account are signed out when the password changes."
    >
      {done ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <p style={{ fontSize: 14, margin: 0 }}>
            You can now sign in with your new password and your second factor.
          </p>
          <Button onClick={() => navigate('/auth/login', { replace: true })}>Go to sign in</Button>
        </div>
      ) : !token ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <p style={{ fontSize: 14, margin: 0, color: tokens.color.danger }}>
            This reset link is missing its token. Open the link from your email again, or request a
            new one.
          </p>
          <Button variant="secondary" onClick={() => navigate('/auth/login', { replace: true })}>
            Back to sign in
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <Input
            type="password"
            label="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
          />
          <Input
            type="password"
            label="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            autoComplete="new-password"
          />
          {mismatch && (
            <div style={{ color: tokens.color.danger, fontSize: 12 }}>Passwords do not match.</div>
          )}
          {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}
          <Button
            type="submit"
            disabled={submitting || password.length < MIN_PASSWORD_LENGTH || mismatch || !confirm}
          >
            {submitting ? 'Saving…' : 'Set new password'}
          </Button>
          <button
            type="button"
            style={linkButtonStyle}
            onClick={() => navigate('/auth/login', { replace: true })}
          >
            Back to sign in
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
