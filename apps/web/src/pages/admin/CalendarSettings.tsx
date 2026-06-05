// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-1 — admin "Calendar Integrations" settings. Register the firm's
// Microsoft 365 / Google OAuth apps; secrets are write-only (masked, never
// returned). Test Connection probes the provider before saving. A provider
// must be enabled before staff can connect it (CAL-2).

import { useEffect, useState } from 'react';
import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface ProviderStatus {
  provider: 'microsoft' | 'google';
  configured: boolean;
  enabled: boolean;
  hasTenant: boolean;
  updatedAt: string | null;
}

const REDIRECT_HINT = (provider: string): string =>
  `${window.location.origin}/api/calendar/oauth/callback/${provider}`;

export function CalendarSettingsPage(): JSX.Element {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ providers: ProviderStatus[] }>('/api/staff/admin/calendar/providers');
      setProviders(r.providers ?? []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 760 }}>
      <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
        Register your firm&apos;s OAuth apps so staff can connect their calendars. Secrets are
        encrypted at rest and never shown again. See the setup guides for{' '}
        <strong>Microsoft 365</strong> and <strong>Google Calendar</strong> in the docs.
      </div>
      {loading ? (
        <div style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <ProviderCard
            provider="microsoft"
            title="Microsoft 365 / Outlook"
            status={providers.find((p) => p.provider === 'microsoft')}
            onSaved={load}
          />
          <ProviderCard
            provider="google"
            title="Google Calendar"
            status={providers.find((p) => p.provider === 'google')}
            onSaved={load}
          />
        </>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  title,
  status,
  onSaved,
}: {
  provider: 'microsoft' | 'google';
  title: string;
  status: ProviderStatus | undefined;
  onSaved: () => void;
}): JSX.Element {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [enabled, setEnabled] = useState(status?.enabled ?? false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setEnabled(status?.enabled ?? false);
  }, [status?.enabled]);

  function body(): Record<string, unknown> {
    const b: Record<string, unknown> = { clientId: clientId.trim(), enabled };
    if (clientSecret.trim()) b['clientSecret'] = clientSecret.trim();
    if (provider === 'microsoft') b['tenantId'] = tenantId.trim();
    return b;
  }

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/staff/admin/calendar/providers/${provider}`, {
        method: 'PUT',
        body: JSON.stringify(body()),
      });
      setClientSecret('');
      setMsg({ ok: true, text: 'Saved.' });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'save_failed' });
    } finally {
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const b: Record<string, unknown> = {};
      if (clientId.trim()) b['clientId'] = clientId.trim();
      if (clientSecret.trim()) b['clientSecret'] = clientSecret.trim();
      if (provider === 'microsoft' && tenantId.trim()) b['tenantId'] = tenantId.trim();
      const r = await api<{ ok: boolean; detail: string }>(
        `/api/staff/admin/calendar/providers/${provider}/test`,
        { method: 'POST', body: JSON.stringify(b) },
      );
      setMsg({ ok: r.ok, text: r.ok ? `Connection OK — ${r.detail}` : `Failed — ${r.detail}` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'test_failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={title}
      action={
        status?.configured ? (
          <Pill tone={status.enabled ? 'success' : 'neutral'}>
            {status.enabled ? 'Enabled' : 'Disabled'}
          </Pill>
        ) : (
          <Pill tone="neutral">Not configured</Pill>
        )
      }
    >
      <div style={{ display: 'grid', gap: tokens.space.md }}>
        <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Redirect URI: <code>{REDIRECT_HINT(provider)}</code>
        </div>
        <Input
          label="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={status?.configured ? '•••• (configured — re-enter to change)' : ''}
        />
        {provider === 'microsoft' && (
          <Input
            label="Tenant ID"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder={status?.hasTenant ? '•••• (configured)' : ''}
          />
        )}
        <Input
          label="Client Secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={status?.configured ? 'Leave blank to keep current secret' : ''}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled (staff can connect this provider)
        </label>
        {msg && (
          <div style={{ fontSize: 13, color: msg.ok ? tokens.color.success : tokens.color.danger }}>
            {msg.text}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={() => void test()} disabled={busy}>
            Test connection
          </Button>
          <Button onClick={() => void save()} disabled={busy || !clientId.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
