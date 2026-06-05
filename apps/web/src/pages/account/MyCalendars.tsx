// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-2 — staff "My Calendars" self-service card on the Account page.
// Connect / disconnect Microsoft 365 + Google, then pick which calendars
// to sync. Only renders when the firm has at least one provider enabled.

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface ProviderRow {
  provider: 'microsoft' | 'google';
  available: boolean;
  connected: boolean;
  providerEmail: string | null;
  syncError: string | null;
  lastSyncedAt: string | null;
}
interface Selection {
  id: string;
  calendarId: string;
  calendarName: string;
  color: string | null;
  isPrimary: boolean;
  syncEnabled: boolean;
}
interface Connection {
  id: string;
  provider: 'microsoft' | 'google';
  providerEmail: string | null;
  syncError: string | null;
  lastSyncedAt: string | null;
  selections: Selection[];
}

const LABEL: Record<string, string> = {
  microsoft: 'Microsoft 365 / Outlook',
  google: 'Google Calendar',
};

export function MyCalendarsCard(): JSX.Element | null {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, c] = await Promise.all([
        api<{ providers: ProviderRow[] }>('/api/staff/calendar/providers'),
        api<{ connections: Connection[] }>('/api/staff/calendar/connections'),
      ]);
      setProviders(p.providers ?? []);
      setConnections(c.connections ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect(provider: string): Promise<void> {
    setBusy(true);
    try {
      const r = await api<{ authorizeUrl: string }>(`/api/staff/calendar/connect/${provider}`, {
        method: 'POST',
      });
      window.location.href = r.authorizeUrl;
    } catch {
      setBusy(false);
    }
  }

  async function syncNow(connectionId: string): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/staff/calendar/connections/${connectionId}/sync`, { method: 'POST' });
      await load();
    } catch {
      // rate-limited or transient — ignore; status reflects on reload
    } finally {
      setBusy(false);
    }
  }

  async function refreshCalendars(connectionId: string): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/staff/calendar/connections/${connectionId}/refresh-calendars`, {
        method: 'POST',
      });
      await load();
    } catch {
      // transient — status reflects on reload
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(connectionId: string): Promise<void> {
    if (!window.confirm('Disconnect this calendar? Synced appointments are kept.')) return;
    setBusy(true);
    try {
      await api(`/api/staff/calendar/connections/${connectionId}`, { method: 'DELETE' });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleCalendar(
    connectionId: string,
    calendarId: string,
    on: boolean,
  ): Promise<void> {
    await api(`/api/staff/calendar/connections/${connectionId}/selections`, {
      method: 'PATCH',
      body: JSON.stringify({ selections: [{ calendarId, syncEnabled: on }] }),
    });
    await load();
  }

  if (loading) return null;
  const anyAvailable = providers.some((p) => p.available);
  if (!anyAvailable) return null; // no provider enabled by the firm

  const connByProvider = new Map(connections.map((c) => [c.provider, c]));

  return (
    <Card title="My Calendars">
      <div style={{ display: 'grid', gap: tokens.space.md }}>
        {providers
          .filter((p) => p.available)
          .map((p) => {
            const conn = connByProvider.get(p.provider);
            return (
              <div
                key={p.provider}
                style={{
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  padding: tokens.space.md,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>{LABEL[p.provider]}</strong>
                  {conn ? (
                    <Pill tone={conn.syncError ? 'danger' : 'success'}>
                      {conn.syncError
                        ? `Error: ${conn.syncError}`
                        : (conn.providerEmail ?? 'Connected')}
                    </Pill>
                  ) : (
                    <Pill tone="neutral">Not connected</Pill>
                  )}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    {conn ? (
                      <>
                        <Button
                          variant="secondary"
                          onClick={() => void syncNow(conn.id)}
                          disabled={busy}
                        >
                          Sync now
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => void refreshCalendars(conn.id)}
                          disabled={busy}
                          title="Re-fetch the list of calendars from the provider"
                        >
                          Refresh calendars
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() => void disconnect(conn.id)}
                          disabled={busy}
                        >
                          Disconnect
                        </Button>
                      </>
                    ) : (
                      <Button onClick={() => void connect(p.provider)} disabled={busy}>
                        Connect
                      </Button>
                    )}
                  </div>
                </div>

                {conn && conn.selections.length > 0 && (
                  <div style={{ marginTop: tokens.space.sm }}>
                    <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                      Calendars to sync
                    </div>
                    {conn.selections.map((s) => (
                      <label
                        key={s.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 13,
                          padding: '2px 0',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={s.syncEnabled}
                          onChange={(e) =>
                            void toggleCalendar(conn.id, s.calendarId, e.target.checked)
                          }
                        />
                        {s.color && (
                          <span
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 2,
                              background: s.color,
                              display: 'inline-block',
                            }}
                          />
                        )}
                        {s.calendarName}
                        {s.isPrimary ? ' (primary)' : ''}
                      </label>
                    ))}
                  </div>
                )}
                {conn && conn.selections.length === 0 && (
                  <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 6 }}>
                    Select at least one calendar to enable sync.
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </Card>
  );
}
