// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P08 — Stripe Connect Standard OAuth admin page.
//
// Three states the firm can be in:
//   1. Operator hasn't configured the platform client id at all.
//      Show a "not configured" message and a runbook hint.
//   2. Configured but firm hasn't connected yet — show a "Connect"
//      button that POSTs /authorize-url and redirects.
//   3. Connected — show stripe_account_id + capability tiles +
//      Refresh + Disconnect actions.

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Button, Card, Pill, SectionHeading, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface AccountStatus {
  connected: boolean;
  configured?: boolean;
  /** True when a working Stripe key is resolvable for real charges — either
   *  a firm-owned key saved below or the appliance env fallback. Independent
   *  of `configured`, which is only about the (optional) Connect OAuth path. */
  firmKeyConfigured?: boolean;
  stripeAccountId?: string;
  stripePublishableKey?: string;
  capabilities?: Record<string, string>;
  connectedAt?: string;
  live?: {
    id: string;
    email: string | null;
    businessProfileName: string | null;
    capabilities: Record<string, string>;
    payoutsEnabled: boolean;
    chargesEnabled: boolean;
    detailsSubmitted: boolean;
  } | null;
}

export function StripeConnectPage(): JSX.Element {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async (refresh = false): Promise<void> => {
    try {
      const r = await api<AccountStatus>(
        `/api/staff/stripe-connect/account-status${refresh ? '?refresh=true' : ''}`,
      );
      setStatus(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load_failed');
    }
  }, []);

  // Handle the callback redirect from Stripe — the operator's
  // STRIPE_CONNECT_REDIRECT_URI should land here (likely /admin/stripe-connect)
  // with ?code=...&state=... in the query string. POST them to /callback
  // then clean up the URL.
  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    if (code && state) {
      setBusy(true);
      void (async () => {
        try {
          await api('/api/staff/stripe-connect/callback', {
            method: 'POST',
            body: JSON.stringify({ code, state }),
          });
          searchParams.delete('code');
          searchParams.delete('state');
          setSearchParams(searchParams, { replace: true });
          await load(true);
        } catch (e) {
          setErr(e instanceof Error ? e.message : 'callback_failed');
        } finally {
          setBusy(false);
        }
      })();
    } else {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startConnect(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ url: string }>('/api/staff/stripe-connect/authorize-url', {
        method: 'POST',
        body: '{}',
      });
      window.location.href = r.url;
    } catch (e) {
      setBusy(false);
      setErr(e instanceof Error ? e.message : 'connect_failed');
    }
  }

  async function disconnect(): Promise<void> {
    if (
      !confirm(
        'Disconnect Stripe? Existing subscriptions on the connected account stay live — this only severs the OAuth link.',
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      await api('/api/staff/stripe-connect/disconnect', { method: 'POST', body: '{}' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'disconnect_failed');
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <div style={{ padding: tokens.space.lg }}>
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>{err ?? 'Loading…'}</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <SectionHeading
        title="Stripe Connect"
        description="Process payments for accepted proposals via Stripe Connect Standard."
      />
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}

      <StripeApiKeysCard />

      {!status.connected ? (
        <Card>
          {status.configured ? (
            <>
              <p style={{ fontSize: 14, marginTop: 0 }}>
                Your firm hasn&apos;t connected a Stripe account yet. Connect to enable card and ACH
                payments on accepted proposals and recurring engagements.
              </p>
              <Button onClick={() => void startConnect()} disabled={busy}>
                {busy ? 'Redirecting…' : 'Connect Stripe'}
              </Button>
            </>
          ) : status.firmKeyConfigured ? (
            <p style={{ fontSize: 13, marginTop: 0 }}>
              <Pill tone="success">Using firm-owned key</Pill> Charges and payments use the
              firm-owned Stripe key above. Stripe Connect (OAuth) is a separate, optional feature
              the operator hasn&apos;t enabled — it lets a firm link its own account via OAuth
              instead of pasting keys, and powers proposal-payment collection and Stripe Terminal.
              To enable it, set <code>STRIPE_CONNECT_CLIENT_ID</code> on the appliance and restart
              the API.
            </p>
          ) : (
            <p style={{ fontSize: 13, marginTop: 0 }}>
              <Pill tone="warning">No Stripe key configured</Pill> Add a secret key above to enable
              payments, or ask the operator to set <code>STRIPE_CONNECT_CLIENT_ID</code> to allow
              connecting via OAuth instead.
            </p>
          )}
        </Card>
      ) : (
        <>
          <Card title="Connected account">
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: 13 }}>
                <strong>Account id:</strong>{' '}
                <code style={{ fontFamily: 'ui-monospace, monospace' }}>
                  {status.stripeAccountId}
                </code>
              </div>
              {status.live?.email && (
                <div style={{ fontSize: 13 }}>
                  <strong>Email:</strong> {status.live.email}
                </div>
              )}
              {status.live?.businessProfileName && (
                <div style={{ fontSize: 13 }}>
                  <strong>Business:</strong> {status.live.businessProfileName}
                </div>
              )}
              {status.connectedAt && (
                <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  Connected {new Date(status.connectedAt).toLocaleString()}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button size="sm" variant="ghost" onClick={() => void load(true)} disabled={busy}>
                  Refresh from Stripe
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void disconnect()} disabled={busy}>
                  Disconnect
                </Button>
              </div>
            </div>
          </Card>

          <Card title="Capabilities">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {Object.keys(status.live?.capabilities ?? status.capabilities ?? {}).length === 0 ? (
                <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
                  No capabilities cached yet. Click &quot;Refresh from Stripe&quot; above.
                </p>
              ) : (
                Object.entries(status.live?.capabilities ?? status.capabilities ?? {}).map(
                  ([cap, state]) => (
                    <Pill
                      key={cap}
                      tone={
                        state === 'active' ? 'success' : state === 'pending' ? 'warning' : 'neutral'
                      }
                    >
                      {cap}: {state}
                    </Pill>
                  ),
                )
              )}
            </div>
            {status.live && (
              <div
                style={{
                  marginTop: 12,
                  fontSize: 12,
                  color: tokens.color.textMuted,
                  display: 'grid',
                  gap: 4,
                }}
              >
                <div>
                  Charges:{' '}
                  <Pill tone={status.live.chargesEnabled ? 'success' : 'warning'}>
                    {status.live.chargesEnabled ? 'enabled' : 'pending'}
                  </Pill>{' '}
                  · Payouts:{' '}
                  <Pill tone={status.live.payoutsEnabled ? 'success' : 'warning'}>
                    {status.live.payoutsEnabled ? 'enabled' : 'pending'}
                  </Pill>{' '}
                  · Details:{' '}
                  <Pill tone={status.live.detailsSubmitted ? 'success' : 'warning'}>
                    {status.live.detailsSubmitted ? 'submitted' : 'incomplete'}
                  </Pill>
                </div>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

interface MaskedStripeConfig {
  secretKeyMasked: string | null;
  publishableKeyMasked: string | null;
  webhookSecretSet: boolean;
}

// Firm-owned Stripe API keys (Q7). Stored encrypted server-side; the form only
// ever shows masked status and sends new values. "Test" validates the secret
// key against Stripe live.
function StripeApiKeysCard(): JSX.Element {
  const [cfg, setCfg] = useState<MaskedStripeConfig | null>(null);
  const [kmsReady, setKmsReady] = useState(true);
  const [secretKey, setSecretKey] = useState('');
  const [publishableKey, setPublishableKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ config: MaskedStripeConfig; kmsReady: boolean }>(
        '/api/staff/admin/stripe-keys',
      );
      setCfg(r.config);
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
      if (secretKey) body['secretKey'] = secretKey.trim();
      if (publishableKey) body['publishableKey'] = publishableKey.trim();
      if (webhookSecret) body['webhookSecret'] = webhookSecret.trim();
      await api('/api/staff/admin/stripe-keys', { method: 'PUT', body: JSON.stringify(body) });
      setSecretKey('');
      setPublishableKey('');
      setWebhookSecret('');
      setMsg({ tone: 'ok', text: 'Saved.' });
      await load();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'save_failed' });
    } finally {
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      // Test the key being entered, else the stored one.
      const body = secretKey.trim() ? { secretKey: secretKey.trim() } : {};
      await api('/api/staff/admin/stripe-keys/test', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setMsg({ tone: 'ok', text: 'Stripe accepted the secret key.' });
    } catch (e) {
      setMsg({
        tone: 'err',
        text: e instanceof Error ? `Test failed: ${e.message}` : 'test_failed',
      });
    } finally {
      setBusy(false);
    }
  }

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
  ): JSX.Element => (
    <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
      {label}
      <input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          padding: '6px 8px',
          fontFamily: tokens.font.mono,
          fontSize: 12,
          borderRadius: tokens.radius.sm,
          border: `1px solid ${tokens.color.border}`,
        }}
      />
    </label>
  );

  return (
    <Card title="Stripe API keys (firm-owned)">
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Paste your own Stripe keys instead of relying on appliance env vars. Stored encrypted. Leave
        a field blank to keep the saved value.
      </p>
      {!kmsReady && (
        <p style={{ fontSize: 12, color: tokens.color.danger }}>
          KMS_KEY is not set on the appliance — keys cannot be encrypted/saved.
        </p>
      )}
      <div style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
        {field(
          `Secret key${cfg?.secretKeyMasked ? ` (saved: ${cfg.secretKeyMasked})` : ''}`,
          secretKey,
          setSecretKey,
          'sk_live_…',
        )}
        {field(
          `Publishable key${cfg?.publishableKeyMasked ? ` (saved: ${cfg.publishableKeyMasked})` : ''}`,
          publishableKey,
          setPublishableKey,
          'pk_live_…',
        )}
        {field(
          `Webhook signing secret${cfg?.webhookSecretSet ? ' (saved)' : ''}`,
          webhookSecret,
          setWebhookSecret,
          'whsec_…',
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button onClick={() => void save()} disabled={busy || !kmsReady}>
            {busy ? 'Working…' : 'Save keys'}
          </Button>
          <Button variant="secondary" onClick={() => void test()} disabled={busy}>
            Test secret key
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
        <p style={{ fontSize: 11, color: tokens.color.textMuted }}>
          Note: charges and inbound webhooks use this saved key automatically, ahead of any
          appliance env vars. Restart the API after saving a new key for it to take effect.
        </p>
      </div>
    </Card>
  );
}
