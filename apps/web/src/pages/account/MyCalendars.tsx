// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-2 — staff "My Calendars" self-service card on the Account page.
// Connect / disconnect Microsoft 365 + Google, then pick which calendars
// to sync. Only renders when the firm has at least one provider enabled.

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  canWrite: boolean;
  selections: Selection[];
}

const LABEL: Record<string, string> = {
  microsoft: 'Microsoft 365 / Outlook',
  google: 'Google Calendar',
};

// syncError values that mean the stored sign-in is dead — fixed only by
// reconnecting (the OAuth upsert resets tokens + clears the error).
const RECONNECT_ERRORS = new Set(['token_expired', 'auth_failed']);

function errorText(syncError: string): string {
  if (RECONNECT_ERRORS.has(syncError)) {
    return 'Calendar sign-in expired — reconnect to resume syncing.';
  }
  if (syncError === 'calendar_list_failed') {
    return "Connected, but the calendar list couldn't be loaded. Try Refresh calendars.";
  }
  return `Error: ${syncError}`;
}

const CONNECT_ERROR_TEXT: Record<string, string> = {
  declined: 'The connection was cancelled at the provider.',
  auth_failed: 'The provider rejected the connection. Try again.',
};

export function MyCalendarsCard(): JSX.Element | null {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useSearchParams();
  // Outcome of an OAuth redirect (?cal_connect=success|error&cal_error=…),
  // captured once then stripped from the URL.
  const [connectResult, setConnectResult] = useState<{ ok: boolean; reason: string | null } | null>(
    null,
  );

  useEffect(() => {
    const status = search.get('cal_connect');
    if (!status) return;
    setConnectResult({ ok: status === 'success', reason: search.get('cal_error') });
    const next = new URLSearchParams(search);
    next.delete('cal_connect');
    next.delete('cal_error');
    setSearch(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, c] = await Promise.all([
        api<{ providers: ProviderRow[] }>('/api/staff/calendar/providers'),
        api<{ connections: Connection[]; writeEnabled?: boolean }>(
          '/api/staff/calendar/connections',
        ),
      ]);
      setProviders(p.providers ?? []);
      setConnections(c.connections ?? []);
      setWriteEnabled(c.writeEnabled ?? false);
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
      {connectResult && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            marginBottom: tokens.space.md,
            borderRadius: tokens.radius.sm,
            fontSize: 13,
            border: `1px solid ${connectResult.ok ? tokens.color.success : tokens.color.danger}`,
            color: connectResult.ok ? tokens.color.success : tokens.color.danger,
          }}
        >
          <span style={{ flex: 1 }}>
            {connectResult.ok
              ? 'Calendar connected.'
              : `Calendar connection failed. ${
                  CONNECT_ERROR_TEXT[connectResult.reason ?? ''] ?? 'Try again.'
                }`}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setConnectResult(null)}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'inherit',
              fontSize: 14,
            }}
          >
            ✕
          </button>
        </div>
      )}
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
                        ? errorText(conn.syncError)
                        : (conn.providerEmail ?? 'Connected')}
                    </Pill>
                  ) : (
                    <Pill tone="neutral">Not connected</Pill>
                  )}
                  {conn && !conn.syncError && writeEnabled && !conn.canWrite && (
                    <span
                      style={{ fontSize: 12, color: tokens.color.textMuted }}
                      title="This connection was made before calendar write was enabled"
                    >
                      Read-only — reconnect to enable calendar write
                    </span>
                  )}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    {conn ? (
                      <>
                        {(RECONNECT_ERRORS.has(conn.syncError ?? '') ||
                          (writeEnabled && !conn.canWrite)) && (
                          <Button onClick={() => void connect(p.provider)} disabled={busy}>
                            Reconnect
                          </Button>
                        )}
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
