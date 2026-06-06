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
  applianceConfigured: boolean;
}

const REDIRECT_HINT = (provider: string): string =>
  `${window.location.origin}/api/calendar/oauth/callback/${provider}`;

// Where the admin obtains the OAuth client id/secret for each provider.
const OAUTH_CONSOLE: Record<'microsoft' | 'google', { url: string; label: string }> = {
  microsoft: {
    url: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    label: 'Microsoft Entra → App registrations',
  },
  google: {
    url: 'https://console.cloud.google.com/apis/credentials',
    label: 'Google Cloud Console → Credentials',
  },
};

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

  const applianceProviders = providers.filter((p) => p.applianceConfigured);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 760 }}>
      {applianceProviders.length > 0 && (
        <div
          style={{
            fontSize: 13,
            color: tokens.color.success,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.success}`,
            borderRadius: tokens.radius.md,
            padding: '10px 14px',
          }}
        >
          ✓ A built-in calendar app is active for{' '}
          <strong>
            {applianceProviders
              .map((p) => (p.provider === 'microsoft' ? 'Microsoft 365' : 'Google'))
              .join(' & ')}
          </strong>
          . Staff can connect their own calendars from <strong>Account → My Calendars</strong> by
          signing in — you do <strong>not</strong> need to register a firm app below. The fields
          below are only for firms that prefer to use their own OAuth app instead.
        </div>
      )}
      <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
        Register your firm&apos;s OAuth apps so staff can connect their calendars. Secrets are
        encrypted at rest and never shown again. Need the steps?{' '}
        <a
          href="/help?article=calendar-oauth-app-registration"
          style={{ color: tokens.color.accent }}
        >
          Read the step-by-step setup guide →
        </a>
      </div>
      {loading ? (
        <div style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <SyncSettingsCard />
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

const REMINDER_OFFSETS: Array<{ minutes: number; label: string }> = [
  { minutes: 10080, label: '7 days before' },
  { minutes: 4320, label: '3 days before' },
  { minutes: 1440, label: '1 day before' },
  { minutes: 120, label: '2 hours before' },
];

function SyncSettingsCard(): JSX.Element {
  const [interval, setInterval] = useState(15);
  const [lookback, setLookback] = useState(7);
  const [lookahead, setLookahead] = useState(90);
  const [offsets, setOffsets] = useState<number[]>([1440, 120]);
  const [quietStart, setQuietStart] = useState('08:00');
  const [quietEnd, setQuietEnd] = useState('20:00');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void api<{
      syncIntervalMinutes: number;
      lookbackDays: number;
      lookaheadDays: number;
      reminderOffsetsMinutes: number[];
      reminderQuietStart?: string;
      reminderQuietEnd?: string;
    }>('/api/staff/admin/calendar/settings').then((s) => {
      setInterval(s.syncIntervalMinutes);
      setLookback(s.lookbackDays);
      setLookahead(s.lookaheadDays);
      setOffsets(s.reminderOffsetsMinutes ?? [1440, 120]);
      if (s.reminderQuietStart) setQuietStart(s.reminderQuietStart);
      if (s.reminderQuietEnd) setQuietEnd(s.reminderQuietEnd);
    });
  }, []);

  function toggleOffset(m: number): void {
    setOffsets((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/staff/admin/calendar/settings', {
        method: 'PUT',
        body: JSON.stringify({
          syncIntervalMinutes: interval,
          lookbackDays: lookback,
          lookaheadDays: lookahead,
          reminderOffsetsMinutes: offsets,
          reminderQuietStart: quietStart,
          reminderQuietEnd: quietEnd,
        }),
      });
      setMsg('Saved.');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Sync schedule">
      <div style={{ display: 'grid', gap: tokens.space.md, gridTemplateColumns: '1fr 1fr 1fr' }}>
        <Input
          label="Interval (min, 5–60)"
          type="number"
          value={String(interval)}
          onChange={(e) => setInterval(Number(e.target.value))}
        />
        <Input
          label="Look back (days)"
          type="number"
          value={String(lookback)}
          onChange={(e) => setLookback(Number(e.target.value))}
        />
        <Input
          label="Look ahead (days)"
          type="number"
          value={String(lookahead)}
          onChange={(e) => setLookahead(Number(e.target.value))}
        />
      </div>
      <div style={{ marginTop: tokens.space.md }}>
        <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 6 }}>
          Appointment reminders
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {REMINDER_OFFSETS.map((o) => (
            <label key={o.minutes} style={{ display: 'flex', gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={offsets.includes(o.minutes)}
                onChange={() => toggleOffset(o.minutes)}
              />
              {o.label}
            </label>
          ))}
        </div>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '6px 0 0' }}>
          The firm default (email) — appointment types and individual bookings can override with
          their own multi-channel schedule.
        </p>
      </div>
      <div style={{ marginTop: tokens.space.md }}>
        <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 6 }}>
          Quiet hours — SMS &amp; voice reminders only fire inside this window (firm timezone).
          Email is always sent.
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'end' }}>
          <Input
            label="From"
            type="time"
            value={quietStart}
            onChange={(e) => setQuietStart(e.target.value)}
          />
          <Input
            label="To"
            type="time"
            value={quietEnd}
            onChange={(e) => setQuietEnd(e.target.value)}
          />
        </div>
      </div>
      <div
        style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: tokens.space.md }}
      >
        {msg && <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{msg}</span>}
        <Button onClick={() => void save()} disabled={busy}>
          Save schedule
        </Button>
      </div>
    </Card>
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
          Get the Client ID &amp; Secret here:{' '}
          <a
            href={OAUTH_CONSOLE[provider].url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: tokens.color.accent }}
          >
            {OAUTH_CONSOLE[provider].label} ↗
          </a>
        </div>
        <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Redirect URI (register this on the app): <code>{REDIRECT_HINT(provider)}</code>
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
