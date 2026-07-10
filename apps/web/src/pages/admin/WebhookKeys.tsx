// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin → Webhook keys. Set the inbound webhook signing secret for each
// notification provider. Each receiver expects the secret in the
// `X-Webhook-Token` header. Stored encrypted; only "set / not set" is shown.

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api } from '../../api-client';

const PROVIDERS = [
  { key: 'postmark', label: 'Postmark (email)', path: 'postmark' },
  { key: 'resend', label: 'Resend (email)', path: 'resend' },
  { key: 'twilio', label: 'Twilio (SMS)', path: 'twilio' },
  { key: 'textlink', label: 'TextLink (SMS)', path: 'textlink' },
] as const;
type ProviderKey = (typeof PROVIDERS)[number]['key'];

const EMPTY_FLAGS: Record<ProviderKey, boolean> = {
  postmark: false,
  resend: false,
  twilio: false,
  textlink: false,
};
const EMPTY_INPUTS: Record<ProviderKey, string> = {
  postmark: '',
  resend: '',
  twilio: '',
  textlink: '',
};

export function WebhookKeysPage(): JSX.Element {
  const [flags, setFlags] = useState<Record<ProviderKey, boolean>>(EMPTY_FLAGS);
  const [kmsReady, setKmsReady] = useState(true);
  const [inputs, setInputs] = useState<Record<ProviderKey, string>>(EMPTY_INPUTS);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ keys: Record<ProviderKey, boolean>; kmsReady: boolean }>(
        '/api/staff/admin/webhook-keys',
      );
      setFlags(r.keys);
      setKmsReady(r.kmsReady);
    } catch {
      /* non-fatal */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, string> = {};
      for (const p of PROVIDERS) if (inputs[p.key]) body[p.key] = inputs[p.key].trim();
      await api('/api/staff/admin/webhook-keys', { method: 'PUT', body: JSON.stringify(body) });
      setInputs(EMPTY_INPUTS);
      setMsg({ tone: 'ok', text: 'Saved.' });
      await load();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'save_failed' });
    } finally {
      setBusy(false);
    }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 760 }}>
      <Card title="Inbound webhook signing keys">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Set a shared secret for each provider&apos;s delivery-status webhook. Configure the same
          value in the provider dashboard and have it sent in the <code>X-Webhook-Token</code>{' '}
          header. Stored encrypted; leave a field blank to keep the saved value. These override the
          appliance env vars.
        </p>
        {!kmsReady && (
          <p style={{ fontSize: 12, color: tokens.color.danger }}>
            KMS_KEY is not set on the appliance — keys cannot be encrypted/saved.
          </p>
        )}
        <div style={{ display: 'grid', gap: 12 }}>
          {PROVIDERS.map((p) => (
            <label key={p.key} style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <span>
                {p.label}{' '}
                {flags[p.key] ? <em style={{ color: tokens.color.textMuted }}>(set)</em> : null}
              </span>
              <input
                type="password"
                autoComplete="off"
                value={inputs[p.key]}
                onChange={(e) => setInputs((s) => ({ ...s, [p.key]: e.target.value }))}
                placeholder={flags[p.key] ? '•••••• (saved)' : 'signing secret'}
                style={{
                  padding: '6px 8px',
                  fontFamily: tokens.font.mono,
                  fontSize: 12,
                  borderRadius: tokens.radius.sm,
                  border: `1px solid ${tokens.color.border}`,
                }}
              />
              <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                POST {origin}/api/webhooks/notifications/{p.path}
              </span>
            </label>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button onClick={() => void save()} disabled={busy || !kmsReady}>
              {busy ? 'Saving…' : 'Save keys'}
            </Button>
            {msg && (
              <span
                style={{
                  fontSize: 12,
                  color: msg.tone === 'ok' ? tokens.color.text : tokens.color.danger,
                }}
              >
                {msg.text}
              </span>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
