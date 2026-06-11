// SPDX-License-Identifier: Elastic-2.0
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

  if (!status.connected && status.configured === false) {
    return (
      <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
        <SectionHeading
          title="Stripe Connect"
          description="Process payments for accepted proposals via Stripe Connect Standard."
        />
        <Card>
          <p style={{ fontSize: 13, marginTop: 0 }}>
            <Pill tone="warning">Not configured</Pill> The operator hasn&apos;t set the
            platform-level Stripe credentials yet. Set <code>STRIPE_CONNECT_CLIENT_ID</code> and{' '}
            <code>STRIPE_SECRET_KEY</code> on the appliance and restart the API.
          </p>
        </Card>
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

      {!status.connected ? (
        <Card>
          <p style={{ fontSize: 14, marginTop: 0 }}>
            Your firm hasn&apos;t connected a Stripe account yet. Connect to enable card and ACH
            payments on accepted proposals and recurring engagements.
          </p>
          <Button onClick={() => void startConnect()} disabled={busy}>
            {busy ? 'Redirecting…' : 'Connect Stripe'}
          </Button>
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
