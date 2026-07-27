// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState } from 'react';
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';
import { MyCalendarsCard } from './account/MyCalendars';

interface CredentialRow {
  id: string;
  label: string | null;
  transports: string[];
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

type Factor = 'TOTP' | 'EMAIL' | 'SMS';

export function AccountPage(): JSX.Element {
  const { me, refresh, logout } = useAuth();
  const [stepUpStatus, setStepUpStatus] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [credsLoaded, setCredsLoaded] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyMsg, setPasskeyMsg] = useState<string | null>(null);

  async function reenrollTotp(): Promise<void> {
    setStepUpStatus('starting…');
    try {
      const r = await api<{ otpauthUri: string }>('/api/auth/totp/enroll', { method: 'POST' });
      setStepUpStatus(`New URI: ${r.otpauthUri}`);
    } catch (err) {
      setStepUpStatus(err instanceof Error ? err.message : 'failed');
    }
  }

  async function loadCredentials(): Promise<void> {
    try {
      const r = await api<{ items: CredentialRow[] }>('/api/auth/webauthn/credentials');
      setCredentials(r.items ?? []);
    } catch {
      setCredentials([]);
    } finally {
      setCredsLoaded(true);
    }
  }

  useEffect(() => {
    void loadCredentials();
  }, []);

  async function addPasskey(): Promise<void> {
    setPasskeyBusy(true);
    setPasskeyMsg(null);
    try {
      const options = await api<PublicKeyCredentialCreationOptionsJSON>(
        '/api/auth/webauthn/registration/options',
        { method: 'POST' },
      );
      const response = await startRegistration({ optionsJSON: options });
      const label = window.prompt('Name this passkey (e.g. "MacBook Touch ID")') ?? undefined;
      await api('/api/auth/webauthn/registration/verify', {
        method: 'POST',
        body: JSON.stringify({ response, label }),
      });
      setPasskeyMsg('Passkey added.');
      await loadCredentials();
    } catch (err) {
      setPasskeyMsg(err instanceof Error ? err.message : 'failed');
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function testPasskey(): Promise<void> {
    setPasskeyBusy(true);
    setPasskeyMsg(null);
    try {
      const options = await api<PublicKeyCredentialRequestOptionsJSON>(
        '/api/auth/webauthn/auth/options',
        { method: 'POST' },
      );
      const response = await startAuthentication({ optionsJSON: options });
      await api('/api/auth/webauthn/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ response }),
      });
      setPasskeyMsg('Step-up confirmed via passkey.');
      await refresh();
    } catch (err) {
      setPasskeyMsg(err instanceof Error ? err.message : 'failed');
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function removePasskey(id: string): Promise<void> {
    if (!window.confirm('Remove this passkey?')) return;
    setPasskeyBusy(true);
    setPasskeyMsg(null);
    try {
      await api(`/api/auth/webauthn/credentials/${id}`, { method: 'DELETE' });
      setPasskeyMsg('Passkey removed.');
      await loadCredentials();
    } catch (err) {
      setPasskeyMsg(err instanceof Error ? err.message : 'failed');
    } finally {
      setPasskeyBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 700 }}>
      <Card title="Identity">
        {me?.fullName && (
          <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 2px' }}>{me.fullName}</p>
        )}
        {me?.email && (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>{me.email}</p>
        )}
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          App user <code style={{ color: tokens.color.text }}>{me?.appUserId}</code>
        </p>
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          Firm <code style={{ color: tokens.color.text }}>{me?.firmId}</code>
        </p>
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          Step-up last verified:{' '}
          {me?.lastStepUpAt ? new Date(me.lastStepUpAt).toLocaleString() : 'never'}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refresh()}>
          Refresh
        </Button>
      </Card>

      <Card title="Two-factor (TOTP)">
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          Generate a fresh TOTP enrollment (e.g. if you lost your authenticator). The current secret
          stays valid until you complete the new one.
        </p>
        <Button onClick={() => void reenrollTotp()}>Generate new enrollment</Button>
        {stepUpStatus && (
          <pre style={{ marginTop: 12, fontSize: 11, color: tokens.color.textMuted }}>
            {stepUpStatus}
          </pre>
        )}
      </Card>

      <SignInSettingsCard />

      <Card title="Passkeys">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginBottom: 12 }}>
          A passkey is a hardware-backed alternative to TOTP. Successful passkey verification counts
          as step-up for sensitive actions.
        </p>
        {!credsLoaded ? (
          <p style={{ fontSize: 12, color: tokens.color.textMuted }}>Loading…</p>
        ) : credentials.length === 0 ? (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 12 }}>
            No passkeys registered yet.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, marginBottom: 12 }}>
            {credentials.map((c) => (
              <li
                key={c.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  padding: '8px 0',
                  fontSize: 13,
                }}
              >
                <div>
                  <div style={{ fontWeight: 500 }}>{c.label ?? 'Unlabeled passkey'}</div>
                  <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                    Added {new Date(c.createdAt).toLocaleDateString()}
                    {c.lastUsedAt
                      ? ` · last used ${new Date(c.lastUsedAt).toLocaleDateString()}`
                      : ' · never used'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {c.backedUp && <Pill tone="success">synced</Pill>}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void removePasskey(c.id)}
                    disabled={passkeyBusy}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => void addPasskey()} disabled={passkeyBusy}>
            Add a passkey
          </Button>
          {credentials.length > 0 && (
            <Button variant="secondary" onClick={() => void testPasskey()} disabled={passkeyBusy}>
              Verify a passkey now
            </Button>
          )}
        </div>
        {passkeyMsg && (
          <p style={{ marginTop: 12, fontSize: 12, color: tokens.color.textMuted }}>{passkeyMsg}</p>
        )}
      </Card>

      <MyCalendarsCard />

      <Card title="Sessions">
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Sign out the current session.</p>
        <Button variant="danger" onClick={() => void logout()}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}

// 0087 — Sign-in settings: set/change password, opt into email OTP,
// enroll SMS OTP, pick a preferred second factor.
function SignInSettingsCard(): JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);

  const [emailEnrolled, setEmailEnrolled] = useState<boolean | null>(null);
  const [smsEnrolled, setSmsEnrolled] = useState<boolean | null>(null);
  const [totpEnrolled, setTotpEnrolled] = useState<boolean | null>(null);
  const [passkeyCount, setPasskeyCount] = useState<number>(0);
  const [preferred, setPreferred] = useState<Factor | null>(null);

  const [phone, setPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsMsg, setSmsMsg] = useState<string | null>(null);
  const [smsStage, setSmsStage] = useState<'idle' | 'verify'>('idle');

  async function loadFactors(): Promise<void> {
    try {
      const r = await api<{
        emailOtpEnrolledAt: string | null;
        smsOtpEnrolledAt: string | null;
        totpEnrolledAt: string | null;
        passkeyCount?: number;
        preferredSecondFactor: Factor | null;
      }>('/api/auth/me');
      setEmailEnrolled(!!r.emailOtpEnrolledAt);
      setSmsEnrolled(!!r.smsOtpEnrolledAt);
      setTotpEnrolled(!!r.totpEnrolledAt);
      setPasskeyCount(r.passkeyCount ?? 0);
      setPreferred(r.preferredSecondFactor);
    } catch {
      // /me may return a slimmer shape; defaults stay null.
    }
  }
  useEffect(() => {
    void loadFactors();
  }, []);

  async function savePassword(): Promise<void> {
    setPwBusy(true);
    setPwMsg(null);
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: currentPassword || undefined,
          newPassword,
        }),
      });
      setPwMsg('Password updated.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setPwMsg(err instanceof Error ? err.message : 'failed');
    } finally {
      setPwBusy(false);
    }
  }

  async function toggleEmail(): Promise<void> {
    try {
      await api(`/api/auth/email-otp/${emailEnrolled ? 'disable' : 'enroll'}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await loadFactors();
    } catch (err) {
      setSmsMsg(err instanceof Error ? err.message : 'failed');
    }
  }

  async function startSmsEnroll(): Promise<void> {
    setSmsBusy(true);
    setSmsMsg(null);
    try {
      const r = await api<{ sentTo: string }>('/api/auth/sms-otp/enroll/start', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      });
      setSmsMsg(`Code sent to ${r.sentTo}.`);
      setSmsStage('verify');
    } catch (err) {
      setSmsMsg(err instanceof Error ? err.message : 'failed');
    } finally {
      setSmsBusy(false);
    }
  }

  async function verifySmsEnroll(): Promise<void> {
    setSmsBusy(true);
    setSmsMsg(null);
    try {
      await api('/api/auth/sms-otp/enroll/verify', {
        method: 'POST',
        body: JSON.stringify({ code: smsCode.trim() }),
      });
      setSmsMsg('SMS factor enrolled.');
      setSmsStage('idle');
      setPhone('');
      setSmsCode('');
      await loadFactors();
    } catch (err) {
      setSmsMsg(err instanceof Error ? err.message : 'failed');
    } finally {
      setSmsBusy(false);
    }
  }

  async function disableSms(): Promise<void> {
    if (!window.confirm('Remove SMS as a second factor?')) return;
    try {
      await api('/api/auth/sms-otp/disable', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await loadFactors();
    } catch (err) {
      setSmsMsg(err instanceof Error ? err.message : 'failed');
    }
  }

  async function setPreference(f: Factor | null): Promise<void> {
    try {
      await api('/api/auth/preferred-factor', {
        method: 'PATCH',
        body: JSON.stringify({ factor: f }),
      });
      setPreferred(f);
    } catch (err) {
      setPwMsg(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <Card title="Sign-in settings">
      <div style={{ display: 'grid', gap: 16 }}>
        <section>
          <h4 style={{ margin: '0 0 6px 0', fontSize: 14 }}>Password</h4>
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
            Enables username + password sign-in. Minimum 12 characters. Leave the current-password
            field blank if you&apos;ve never set one before.
          </p>
          <div style={{ display: 'grid', gap: 6, maxWidth: 360 }}>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Current password (only if changing)"
              autoComplete="current-password"
              style={inputStyle}
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
              autoComplete="new-password"
              style={inputStyle}
            />
            <div>
              <Button
                onClick={() => void savePassword()}
                disabled={pwBusy || newPassword.length < 12}
              >
                {pwBusy ? 'Saving…' : 'Save password'}
              </Button>
            </div>
            {pwMsg && (
              <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>{pwMsg}</p>
            )}
          </div>
        </section>

        <section>
          <h4 style={{ margin: '0 0 6px 0', fontSize: 14 }}>Second factor</h4>
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
            Pick at least one. Required if you sign in with a password.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            <li
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 8,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
              }}
            >
              <div>
                <strong style={{ fontSize: 13 }}>Passkey (WebAuthn)</strong>
                <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  {passkeyCount > 0
                    ? `${passkeyCount} passkey${passkeyCount === 1 ? '' : 's'} registered. Use the Passkeys card above to add or remove. Passkey is auto-preferred at sign-in.`
                    : 'Not enrolled — use the Passkeys card above to add one. Passkey is the strongest second factor.'}
                </div>
              </div>
            </li>
            <li
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 8,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
              }}
            >
              <div>
                <strong style={{ fontSize: 13 }}>Authenticator app (TOTP)</strong>
                <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  {totpEnrolled ? 'Enrolled' : 'Not enrolled — use the section above to enroll.'}
                </div>
              </div>
              {preferred === 'TOTP' && <Pill tone="accent">preferred</Pill>}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void setPreference('TOTP')}
                disabled={!totpEnrolled || preferred === 'TOTP'}
              >
                Set preferred
              </Button>
            </li>
            <li
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 8,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
              }}
            >
              <div>
                <strong style={{ fontSize: 13 }}>Email code</strong>
                <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  {emailEnrolled
                    ? 'Enrolled — a code is emailed at sign-in.'
                    : 'Opt in to receive sign-in codes by email.'}
                </div>
              </div>
              {preferred === 'EMAIL' && <Pill tone="accent">preferred</Pill>}
              <div style={{ display: 'flex', gap: 6 }}>
                <Button size="sm" variant="secondary" onClick={() => void toggleEmail()}>
                  {emailEnrolled ? 'Disable' : 'Enable'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void setPreference('EMAIL')}
                  disabled={!emailEnrolled || preferred === 'EMAIL'}
                >
                  Set preferred
                </Button>
              </div>
            </li>
            <li
              style={{
                display: 'grid',
                gap: 8,
                padding: 8,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>
                  <strong style={{ fontSize: 13 }}>Text message (SMS)</strong>
                  <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                    {smsEnrolled
                      ? 'Enrolled — a code is texted at sign-in.'
                      : 'Enroll your mobile number to receive sign-in codes.'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {preferred === 'SMS' && <Pill tone="accent">preferred</Pill>}
                  {smsEnrolled && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void setPreference('SMS')}
                        disabled={preferred === 'SMS'}
                      >
                        Set preferred
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void disableSms()}>
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {!smsEnrolled && smsStage === 'idle' && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+15551234567"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <Button
                    size="sm"
                    onClick={() => void startSmsEnroll()}
                    disabled={!/^\+[1-9]\d{7,14}$/.test(phone) || smsBusy}
                  >
                    Send code
                  </Button>
                </div>
              )}
              {smsStage === 'verify' && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={smsCode}
                    onChange={(e) => setSmsCode(e.target.value)}
                    placeholder="6-digit code"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <Button
                    size="sm"
                    onClick={() => void verifySmsEnroll()}
                    disabled={smsCode.trim().length < 6 || smsBusy}
                  >
                    Verify
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSmsStage('idle')}>
                    Cancel
                  </Button>
                </div>
              )}
              {smsMsg && (
                <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>{smsMsg}</p>
              )}
            </li>
          </ul>
        </section>
      </div>
    </Card>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
};
