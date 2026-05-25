// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';

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
