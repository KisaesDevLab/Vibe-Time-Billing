// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';
import {
  disablePush,
  enablePush,
  isIos,
  isPushSubscribed,
  isStandalone,
  pushSupported,
} from '../pwa';

type Channel = 'EMAIL' | 'SMS';
type Event =
  | 'newInvoice'
  | 'paymentConfirmation'
  | 'paymentFailed'
  | 'documentReady'
  | 'autoPayUpcoming'
  | 'statementMonthly'
  | 'deliverableUnlocked';

interface Prefs {
  newInvoice: Channel[];
  paymentConfirmation: Channel[];
  paymentFailed: Channel[];
  documentReady: Channel[];
  autoPayUpcoming: Channel[];
  statementMonthly: Channel[];
  deliverableUnlocked: Channel[];
}

const EVENT_LABELS: Record<Event, string> = {
  newInvoice: 'New invoice posted',
  paymentConfirmation: 'Payment confirmation',
  paymentFailed: 'Payment failed',
  documentReady: 'Document ready',
  autoPayUpcoming: 'Upcoming autopay run',
  statementMonthly: 'Monthly statement',
  deliverableUnlocked: 'Files released after payment',
};

function PushNotificationCard(): JSX.Element {
  const [state, setState] = useState<'loading' | 'unsupported' | 'disabled' | 'ready'>('loading');
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (!pushSupported()) {
        setState('unsupported');
        return;
      }
      try {
        const cfg = await api<{ enabled: boolean }>('/api/portal/push/key');
        if (!cfg.enabled) {
          setState('disabled');
          return;
        }
        setSubscribed(await isPushSubscribed());
        setState('ready');
      } catch {
        setState('disabled');
      }
    })();
  }, []);

  async function enable(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const r = await enablePush();
      if (r === 'enabled') {
        setSubscribed(true);
        setMsg('Push notifications are on for this device.');
      } else if (r === 'denied') {
        setMsg('Notifications are blocked in your browser settings — allow them, then try again.');
      } else if (r === 'unsupported') {
        setMsg('This browser does not support push notifications.');
      } else {
        setMsg('Push notifications are not available right now.');
      }
    } catch {
      setMsg('Could not enable push notifications.');
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      await disablePush();
      setSubscribed(false);
      setMsg('Push notifications are off for this device.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Push notifications (this device)">
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Get a notification on this device whenever your firm posts something new — even when the
        portal isn’t open. Push is per-device, so enable it on each phone or computer you use.
      </p>
      {state === 'loading' && (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Checking…</p>
      )}
      {state === 'unsupported' && (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          This browser doesn’t support push notifications.
        </p>
      )}
      {state === 'disabled' && (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          Push notifications aren’t configured for this portal.
        </p>
      )}
      {state === 'ready' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {subscribed ? (
            <>
              <Pill tone="success">On for this device</Pill>
              <Button variant="secondary" size="sm" onClick={() => void disable()} disabled={busy}>
                Turn off
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => void enable()} disabled={busy}>
              Enable on this device
            </Button>
          )}
        </div>
      )}
      {state === 'ready' && isIos() && !isStandalone() && (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 10 }}>
          On iPhone/iPad, first add this portal to your Home Screen (Share → “Add to Home Screen”),
          then open it from there to enable notifications.
        </p>
      )}
      {msg && (
        <p style={{ fontSize: 12, color: tokens.color.text, marginTop: 10 }} role="status">
          {msg}
        </p>
      )}
    </Card>
  );
}

export function NotificationPrefsPage(): JSX.Element {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ preferences: Prefs | null }>(
          '/api/portal/profile/notification-preferences',
        );
        setPrefs({
          newInvoice: r.preferences?.newInvoice ?? ['EMAIL'],
          paymentConfirmation: r.preferences?.paymentConfirmation ?? ['EMAIL'],
          paymentFailed: r.preferences?.paymentFailed ?? ['EMAIL', 'SMS'],
          documentReady: r.preferences?.documentReady ?? ['EMAIL'],
          autoPayUpcoming: r.preferences?.autoPayUpcoming ?? [],
          statementMonthly: r.preferences?.statementMonthly ?? ['EMAIL'],
          deliverableUnlocked: r.preferences?.deliverableUnlocked ?? ['EMAIL'],
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, []);

  function toggle(event: Event, channel: Channel): void {
    if (!prefs) return;
    const set = new Set(prefs[event]);
    if (set.has(channel)) set.delete(channel);
    else set.add(channel);
    setPrefs({ ...prefs, [event]: Array.from(set) });
  }

  async function save(): Promise<void> {
    if (!prefs) return;
    setError(null);
    try {
      await api('/api/portal/profile/notification-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferences: prefs }),
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  if (!prefs) return <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 700 }}>
      <PushNotificationCard />
      <Card title="Notification preferences (active client)">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Pick the channel(s) you want for each event type. Empty means no notification will be sent
          for that event.
        </p>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 13,
            marginTop: 12,
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  color: tokens.color.textMuted,
                  fontWeight: 500,
                }}
              >
                Event
              </th>
              <th
                style={{
                  textAlign: 'center',
                  padding: '8px 12px',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  color: tokens.color.textMuted,
                  fontWeight: 500,
                }}
              >
                Email
              </th>
              <th
                style={{
                  textAlign: 'center',
                  padding: '8px 12px',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  color: tokens.color.textMuted,
                  fontWeight: 500,
                }}
              >
                SMS
              </th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(EVENT_LABELS) as Event[]).map((ev) => (
              <tr key={ev}>
                <td
                  style={{
                    padding: '8px 12px',
                    borderBottom: `1px solid ${tokens.color.border}`,
                  }}
                >
                  {EVENT_LABELS[ev]}
                </td>
                <td
                  style={{
                    padding: '8px 12px',
                    textAlign: 'center',
                    borderBottom: `1px solid ${tokens.color.border}`,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={prefs[ev].includes('EMAIL')}
                    onChange={() => toggle(ev, 'EMAIL')}
                  />
                </td>
                <td
                  style={{
                    padding: '8px 12px',
                    textAlign: 'center',
                    borderBottom: `1px solid ${tokens.color.border}`,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={prefs[ev].includes('SMS')}
                    onChange={() => toggle(ev, 'SMS')}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div
          style={{
            marginTop: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <Button onClick={() => void save()}>Save</Button>
          {savedAt && <Pill tone="success">Saved at {new Date(savedAt).toLocaleTimeString()}</Pill>}
          {error && <span style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</span>}
        </div>
      </Card>
    </div>
  );
}
