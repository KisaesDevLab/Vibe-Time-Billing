// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin → SMS inbox (0233). Everything the two-way texting inbox needs that
// is not a credential: enable flag, public base URL + generated webhook
// URLs, the firm's texting lines (ingest / default assignee / default
// line), polling + retention knobs, default work code for SMS time
// entries, PII warnings, consent enforcement, A2P status, and a health
// card. Credentials live on Email + SMS providers.

import { useCallback, useEffect, useState } from 'react';

import {
  Button,
  Card,
  Combobox,
  EmptyState,
  Pill,
  ResponsiveGrid,
  Stat,
  Table,
  tokens,
} from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';
import { A2pBanner } from '../sms/A2pBanner';
import type { SmsHealth, SmsInboxSettings, SmsLine } from '../sms/types';

interface AppUser {
  id: string;
  fullName: string;
  status?: string;
}

interface WorkCode {
  id: string;
  key: string;
  name: string;
}

const fieldStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
};
const labelStyle: React.CSSProperties = { fontSize: 12, color: tokens.color.textMuted };
const muted: React.CSSProperties = { fontSize: 12, color: tokens.color.textMuted };

function fmtTime(v: string | null | undefined): string {
  if (!v) return 'never';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

export function SmsInboxSettingsPage(): JSX.Element {
  // Phase 11 introduces sms:settings; until then this page follows the
  // provider page's firm:settings:write gate.
  const canManage = usePermission('firm:settings:write');
  const [settings, setSettings] = useState<SmsInboxSettings | null>(null);
  const [lines, setLines] = useState<SmsLine[]>([]);
  const [health, setHealth] = useState<SmsHealth | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [workCodes, setWorkCodes] = useState<WorkCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);

  // Drafts for the text/number inputs (saved per card).
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [pollMinutes, setPollMinutes] = useState('2');
  const [retUnassigned, setRetUnassigned] = useState('90');
  const [retSpam, setRetSpam] = useState('30');

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ settings: SmsInboxSettings; lines: SmsLine[]; health: SmsHealth }>(
        '/api/staff/sms/settings',
      );
      setSettings(r.settings);
      setLines(r.lines);
      setHealth(r.health);
      setPublicBaseUrl(r.settings.publicBaseUrl ?? '');
      setPollMinutes(String(r.settings.pollIntervalMinutes));
      setRetUnassigned(String(r.settings.retentionUnassignedDays));
      setRetSpam(String(r.settings.retentionSpamDays));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }, []);

  useEffect(() => {
    void load();
    void api<{ users: AppUser[] }>('/api/staff/admin/users')
      .then((r) => setUsers((r.users ?? []).filter((u) => u.status !== 'DISABLED')))
      .catch(() => undefined);
    void api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes')
      .then((r) => setWorkCodes(r.items ?? []))
      .catch(() => undefined);
    const t = setInterval(() => {
      void api<SmsHealth>('/api/staff/sms/settings/health')
        .then(setHealth)
        .catch(() => undefined);
    }, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function patch(card: string, body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setStatus((s) => ({ ...s, [card]: null }));
    try {
      const r = await api<{ settings: SmsInboxSettings }>('/api/staff/sms/settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setSettings(r.settings);
      setStatus((s) => ({ ...s, [card]: 'Saved.' }));
    } catch (e) {
      const issues = (
        e as { body?: { issues?: Array<{ path?: (string | number)[]; message?: string }> } }
      ).body?.issues;
      setStatus((s) => ({
        ...s,
        [card]: issues?.length
          ? `Invalid — ${issues.map((i) => `${(i.path ?? []).join('.')}: ${i.message ?? ''}`).join('; ')}`
          : e instanceof Error
            ? e.message
            : 'save_failed',
      }));
    } finally {
      setBusy(false);
    }
  }

  async function patchLine(id: string, body: Record<string, unknown>): Promise<void> {
    try {
      const r = await api<{ items: SmsLine[] }>(`/api/staff/sms/settings/lines/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setLines(r.items);
    } catch (e) {
      setStatus((s) => ({ ...s, lines: e instanceof Error ? e.message : 'save_failed' }));
    }
  }

  async function syncLines(): Promise<void> {
    setBusy(true);
    setStatus((s) => ({ ...s, lines: 'Refreshing from Twilio…' }));
    try {
      const r = await api<{ added: number; archived: number; items: SmsLine[] }>(
        '/api/staff/sms/settings/lines/sync',
        { method: 'POST' },
      );
      setLines(r.items);
      setStatus((s) => ({ ...s, lines: `Synced — ${r.added} added, ${r.archived} archived.` }));
    } catch (e) {
      const body = (e as { body?: { error?: string; detail?: string } }).body;
      setStatus((s) => ({
        ...s,
        lines:
          body?.error === 'inbox_not_configured'
            ? 'Add Twilio credentials and a Messaging Service SID first.'
            : `Failed: ${body?.detail ?? (e instanceof Error ? e.message : 'sync_failed')}`,
      }));
    } finally {
      setBusy(false);
    }
  }

  async function refreshA2p(): Promise<void> {
    setStatus((s) => ({ ...s, a2p: 'Checking…' }));
    try {
      const r = await api<{ status: string }>('/api/staff/sms/settings/a2p/refresh', {
        method: 'POST',
      });
      setStatus((s) => ({ ...s, a2p: `Twilio reports: ${r.status}` }));
      await load();
    } catch (e) {
      setStatus((s) => ({ ...s, a2p: e instanceof Error ? e.message : 'check_failed' }));
    }
  }

  if (!canManage) {
    return <EmptyState title="Firm settings permission required" body="Ask an administrator." />;
  }
  if (!settings) {
    return <p style={muted}>{error ?? 'Loading…'}</p>;
  }

  const userOptions = [
    { value: '', label: '— none —' },
    ...users.map((u) => ({ value: u.id, label: u.fullName })),
  ];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 960 }}>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
          {error}
        </p>
      )}

      {!settings.providerReady && (
        <EmptyState
          title="Twilio isn't set up for the inbox yet"
          body="Add Twilio credentials and a Messaging Service SID under Email + SMS providers, then come back to enable the inbox and pull in your numbers."
          cta={
            <a href="/admin/messaging" style={{ color: tokens.color.accent, fontSize: 13 }}>
              Open Email + SMS providers →
            </a>
          }
        />
      )}

      <A2pBanner status={settings.a2p.status} configured={settings.enabled} showAdminLink={false} />

      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>Two-way SMS inbox</span>
            {settings.enabled ? (
              <Pill tone="success">enabled</Pill>
            ) : (
              <Pill tone="neutral">disabled</Pill>
            )}
          </span>
        }
      >
        <p style={{ ...muted, marginTop: 0 }}>
          When enabled, texts to any ingesting line below land in Messages → SMS, and reminders,
          booking confirmations, and client-request notices are sent through the Messaging Service
          so replies thread back to the same conversation.
        </p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={busy || (!settings.providerReady && !settings.enabled)}
            onChange={(e) => void patch('enable', { enabled: e.target.checked })}
          />
          Enable the SMS inbox
        </label>
        {status['enable'] && <p style={muted}>{status['enable']}</p>}
      </Card>

      <Card
        title="Health"
        action={
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Re-check
          </Button>
        }
      >
        {health?.webhookGap && (
          <p style={{ color: tokens.color.danger, fontSize: 13 }} role="alert">
            Polling is finding inbound texts that the webhook never delivered — check the public URL
            below and that the tunnel / firewall reaches this appliance.
          </p>
        )}
        <ResponsiveGrid min={160}>
          <Stat label="Last inbound webhook" value={fmtTime(health?.lastInboundWebhookAt)} />
          <Stat label="Last status callback" value={fmtTime(health?.lastStatusWebhookAt)} />
          <Stat
            label="Last poll"
            value={fmtTime(health?.lastPollAt)}
            tone={health?.poll?.lastOk === false ? 'danger' : 'neutral'}
            caption={health?.poll?.lastError ?? undefined}
          />
          <Stat label="Last send" value={fmtTime(health?.lastSendAt)} />
          <Stat
            label="Rejected signatures (24h)"
            value={health?.webhook?.invalidSignature24h ?? 0}
            tone={(health?.webhook?.invalidSignature24h ?? 0) > 0 ? 'warning' : 'neutral'}
          />
          <Stat
            label="Send failures (24h)"
            value={health?.send?.failures24h ?? 0}
            tone={(health?.send?.failures24h ?? 0) > 0 ? 'warning' : 'neutral'}
            caption={health?.send?.lastError ?? undefined}
          />
        </ResponsiveGrid>
        {health?.lines?.autoDiscovered?.length ? (
          <p style={{ ...muted, marginBottom: 0 }}>
            Auto-discovered lines from inbound texts: {health.lines.autoDiscovered.join(', ')} —
            label them below.
          </p>
        ) : null}
      </Card>

      <Card
        title="Lines"
        action={
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !settings.providerReady}
            onClick={() => void syncLines()}
            title={settings.providerReady ? undefined : 'Configure Twilio first'}
          >
            Refresh from Twilio
          </Button>
        }
      >
        <p style={{ ...muted, marginTop: 0 }}>
          Numbers in your Messaging Service. Turn off ingest for a number whose texts should not
          reach the inbox. The default line is used for new outbound conversations; replies always
          go out on the line the client texted.
        </p>
        <Table<SmsLine>
          rows={lines}
          rowKey={(l) => l.id}
          mobileLayout="cards"
          empty={
            <span style={muted}>
              No numbers yet — add one to the Messaging Service in Twilio, then Refresh.
            </span>
          }
          columns={[
            {
              key: 'number',
              header: 'Number',
              mobile: 'title',
              render: (l) => (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{l.phoneNumberE164}</span>
              ),
            },
            {
              key: 'label',
              header: 'Label',
              mobile: 'field',
              render: (l) => (
                <input
                  defaultValue={l.label ?? ''}
                  placeholder="e.g. Front desk"
                  aria-label={`Label for ${l.phoneNumberE164}`}
                  style={{ ...fieldStyle, width: '100%' }}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== (l.label ?? '')) void patchLine(l.id, { label: v || null });
                  }}
                />
              ),
            },
            {
              key: 'ingest',
              header: 'Ingest',
              mobile: 'field',
              render: (l) => (
                <input
                  type="checkbox"
                  aria-label={`Ingest texts to ${l.phoneNumberE164}`}
                  checked={l.ingest}
                  onChange={(e) => void patchLine(l.id, { ingest: e.target.checked })}
                />
              ),
            },
            {
              key: 'assignee',
              header: 'Default assignee',
              mobile: 'field',
              render: (l) => (
                <Combobox
                  ariaLabel={`Default assignee for ${l.phoneNumberE164}`}
                  size="sm"
                  value={l.defaultAssigneeUserId ?? ''}
                  onChange={(v) => void patchLine(l.id, { defaultAssigneeUserId: v || null })}
                  options={userOptions}
                />
              ),
            },
            {
              key: 'default',
              header: 'Default line',
              mobile: 'badge',
              render: (l) =>
                l.isDefault ? (
                  <Pill tone="accent">default</Pill>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void patchLine(l.id, { isDefault: true })}
                  >
                    Make default
                  </Button>
                ),
            },
          ]}
        />
        {status['lines'] && <p style={muted}>{status['lines']}</p>}
      </Card>

      <Card title="Webhooks">
        <p style={{ ...muted, marginTop: 0 }}>
          Twilio must reach this appliance on a public URL. Paste the inbound URL into Messaging
          Service → Integration → &ldquo;Send a webhook&rdquo;; the status URL is attached to every
          send automatically. Leave the override blank to use{' '}
          <code>
            {settings.publicBaseUrlSource === 'firm'
              ? 'this override'
              : settings.publicBaseUrlSource.toUpperCase()}
          </code>
          .
        </p>
        <label style={{ display: 'grid', gap: 4, marginBottom: 8 }}>
          <span style={labelStyle}>Public base URL override</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={publicBaseUrl}
              onChange={(e) => setPublicBaseUrl(e.target.value)}
              placeholder={settings.effectivePublicBaseUrl}
              style={{ ...fieldStyle, flex: 1 }}
            />
            <Button
              disabled={busy}
              onClick={() =>
                void patch('webhooks', { publicBaseUrl: publicBaseUrl.trim() || null })
              }
            >
              Save
            </Button>
          </div>
        </label>
        <div style={{ display: 'grid', gap: 6 }}>
          {(['inbound', 'status'] as const).map((k) => (
            <div
              key={k}
              style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
            >
              <span style={{ ...labelStyle, width: 64 }}>
                {k === 'inbound' ? 'Inbound' : 'Status'}
              </span>
              <code
                style={{
                  flex: 1,
                  minWidth: 200,
                  fontSize: 12,
                  padding: '6px 8px',
                  background: tokens.color.surface,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  overflowWrap: 'anywhere',
                }}
              >
                {settings.webhookUrls[k]}
              </code>
              <CopyButton text={settings.webhookUrls[k]} />
            </div>
          ))}
        </div>
        <p style={{ ...muted, marginBottom: 0 }}>
          Signature check:{' '}
          {health?.lastInboundWebhookAt ? (
            <Pill tone="success">verified {fmtTime(health.lastInboundWebhookAt)}</Pill>
          ) : (
            <Pill tone="neutral">no verified webhook yet</Pill>
          )}
        </p>
        {status['webhooks'] && <p style={muted}>{status['webhooks']}</p>}
      </Card>

      <Card title="Polling and 10DLC">
        <p style={{ ...muted, marginTop: 0 }}>
          The reconciler polls Twilio for anything the webhook missed (appliances behind NAT) and
          back-fills delivery status. A2P 10DLC registration is checked every few hours.
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>Polling interval (minutes)</span>
            <input
              type="number"
              min={1}
              max={60}
              value={pollMinutes}
              onChange={(e) => setPollMinutes(e.target.value)}
              style={{ ...fieldStyle, width: 120 }}
            />
          </label>
          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              fontSize: 13,
              paddingBottom: 8,
            }}
          >
            <input
              type="checkbox"
              checked={settings.a2p.overrideAllow}
              onChange={(e) => void patch('polling', { a2pOverrideAllow: e.target.checked })}
            />
            Allow sends while 10DLC is unregistered (toll-free / short code lines)
          </label>
          <Button
            disabled={busy}
            onClick={() => void patch('polling', { pollIntervalMinutes: Number(pollMinutes) })}
          >
            Save
          </Button>
          <Button
            variant="secondary"
            disabled={!settings.providerReady}
            onClick={() => void refreshA2p()}
          >
            Check 10DLC now
          </Button>
        </div>
        <p style={{ ...muted, marginBottom: 0 }}>
          10DLC status:{' '}
          <Pill tone={settings.a2p.status === 'registered' ? 'success' : 'warning'}>
            {settings.a2p.status}
          </Pill>{' '}
          {settings.a2p.checkedAt ? `(checked ${fmtTime(settings.a2p.checkedAt)})` : ''}
          {status['a2p'] ? ` · ${status['a2p']}` : ''}
          {status['polling'] ? ` · ${status['polling']}` : ''}
        </p>
        <p style={{ ...muted, marginBottom: 0 }}>
          Also enable <strong>Advanced Opt-Out</strong> on the Messaging Service in the Twilio
          console — STOP/START are honored locally too, but Twilio&apos;s handling adds the carrier
          auto-replies.
        </p>
      </Card>

      <Card title="Time entries, compliance, retention">
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gap: 4, maxWidth: 420 }}>
            <span style={labelStyle}>Default work code for SMS time entries</span>
            <Combobox
              ariaLabel="Default work code for SMS time entries"
              value={settings.defaultWorkCodeId ?? ''}
              onChange={(v) => void patch('misc', { defaultWorkCodeId: v || null })}
              options={[
                { value: '', label: "— use the engagement's in-scope code —" },
                ...workCodes.map((w) => ({ value: w.id, label: `${w.key} · ${w.name}` })),
              ]}
            />
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={settings.piiWarningsEnabled}
              onChange={(e) => void patch('misc', { piiWarningsEnabled: e.target.checked })}
            />
            Warn when an outbound text looks like it contains an SSN, EIN, account, card, or DOB
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={settings.consentEnforced}
              onChange={(e) => void patch('misc', { consentEnforced: e.target.checked })}
            />
            Block outbound-initiated texts to contacts with no SMS consent on file (replies are
            never blocked)
          </label>
          <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>Purge unassigned conversations after (days)</span>
              <input
                type="number"
                min={1}
                value={retUnassigned}
                onChange={(e) => setRetUnassigned(e.target.value)}
                style={{ ...fieldStyle, width: 140 }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>Purge spam / closed-unassigned after (days)</span>
              <input
                type="number"
                min={1}
                value={retSpam}
                onChange={(e) => setRetSpam(e.target.value)}
                style={{ ...fieldStyle, width: 140 }}
              />
            </label>
            <Button
              disabled={busy}
              onClick={() =>
                void patch('misc', {
                  retentionUnassignedDays: Number(retUnassigned),
                  retentionSpamDays: Number(retSpam),
                })
              }
            >
              Save
            </Button>
          </div>
          <p style={{ ...muted, margin: 0 }}>
            Conversations linked to a client follow that client&apos;s retention and are never
            purged here.
          </p>
          {status['misc'] && <p style={muted}>{status['misc']}</p>}
        </div>
      </Card>
    </div>
  );
}
