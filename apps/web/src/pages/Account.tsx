// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';

export function AccountPage(): JSX.Element {
  const { me, refresh, logout } = useAuth();
  const [stepUpStatus, setStepUpStatus] = useState<string | null>(null);

  async function reenrollTotp(): Promise<void> {
    setStepUpStatus('starting…');
    try {
      const r = await api<{ otpauthUri: string }>('/api/auth/totp/enroll', { method: 'POST' });
      setStepUpStatus(`New URI: ${r.otpauthUri}`);
    } catch (err) {
      setStepUpStatus(err instanceof Error ? err.message : 'failed');
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

      <Card title="Two-factor">
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

      <Card title="Sessions">
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Sign out the current session.</p>
        <Button variant="danger" onClick={() => void logout()}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}
