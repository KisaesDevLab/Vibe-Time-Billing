// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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

interface CredentialRow {
  id: string;
  label: string | null;
  transports: string[];
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

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

      <Card title="Sessions">
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Sign out the current session.</p>
        <Button variant="danger" onClick={() => void logout()}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}
