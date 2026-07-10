// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP5 — Consolidated portal profile page (Build Plan §2.3).
//
// Single page with three sections:
//   • Identity — read-only name/email/phone + preferred login method.
//     Edit only via the firm's contact-change flow (privacy).
//   • Alt contacts — embeds the existing AltContactsPage so users can
//     add backup verification channels. The /alt-contacts route stays
//     reachable for bookmarks.
//   • Active sessions — live Redis-backed list of every place the
//     portal identity is signed in, with a "Sign out everywhere else"
//     action.

import { useEffect, useState } from 'react';

import {
  Button,
  Card,
  EmptyState,
  Pill,
  SectionHeading,
  Table,
  tokens,
  useIsNarrow,
} from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';
import { AltContactsPage } from './AltContacts';

interface IdentityResp {
  identity: {
    id: string;
    fullName: string;
    primaryEmail: string | null;
    primaryPhone: string | null;
    preferredMethod: 'EMAIL' | 'SMS' | null;
    status: string;
  } | null;
}

interface SessionRow {
  id: string;
  isCurrent: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export function ProfilePage(): JSX.Element {
  const narrow = useIsNarrow();
  const { logout } = useAuth();
  const [identity, setIdentity] = useState<IdentityResp['identity']>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadAll(): Promise<void> {
    try {
      const [me, s] = await Promise.all([
        api<IdentityResp>('/api/portal/profile/me'),
        api<{ items: SessionRow[] }>('/api/portal/profile/sessions'),
      ]);
      setIdentity(me.identity);
      setSessions(s.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function revokeOthers(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await api('/api/portal/profile/sessions/revoke-others', {
        method: 'POST',
        body: '{}',
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900, margin: '0 auto' }}>
      <SectionHeading
        title="Profile"
        description="Your account details, backup contact channels, and active sessions."
      />

      <section>
        <SectionHeading eyebrow="You" title="Identity" />
        <Card>
          {!loaded ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
          ) : !identity ? (
            <EmptyState title="Identity unavailable" body="Sign out and back in." />
          ) : (
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: narrow ? '1fr' : '160px 1fr',
                gap: '8px 16px',
                margin: 0,
                fontSize: 14,
              }}
            >
              <dt style={{ color: tokens.color.textMuted }}>Name</dt>
              <dd style={{ margin: 0 }}>{identity.fullName}</dd>
              <dt style={{ color: tokens.color.textMuted }}>Email</dt>
              <dd style={{ margin: 0 }}>{identity.primaryEmail ?? '—'}</dd>
              <dt style={{ color: tokens.color.textMuted }}>Phone</dt>
              <dd style={{ margin: 0 }}>{identity.primaryPhone ?? '—'}</dd>
              <dt style={{ color: tokens.color.textMuted }}>Preferred login</dt>
              <dd style={{ margin: 0 }}>{identity.preferredMethod ?? 'EMAIL'}</dd>
            </dl>
          )}
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 12 }}>
            To change your name, primary email, or phone, contact your firm directly. Backup
            channels can be added below.
          </p>
        </Card>
      </section>

      <section>
        <SectionHeading eyebrow="Backup channels" title="Alternate contacts" />
        <AltContactsPage />
      </section>

      <section>
        <SectionHeading
          eyebrow="Security"
          title={`Active sessions (${sessions.length})`}
          description="Devices currently signed in to the portal as you."
          action={
            sessions.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void revokeOthers()}
                disabled={busy}
              >
                Sign out everywhere else
              </Button>
            ) : undefined
          }
        />
        <Card>
          {!loaded ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
          ) : sessions.length === 0 ? (
            <EmptyState title="No active sessions" body="This is unusual — try signing out." />
          ) : (
            <Table<SessionRow>
              columns={[
                {
                  key: 'device',
                  header: 'Device',
                  render: (s) => (
                    <span style={{ fontSize: 13 }}>
                      {summarizeUserAgent(s.userAgent)}
                      {s.isCurrent && <Pill tone="success">this device</Pill>}
                    </span>
                  ),
                },
                {
                  key: 'ip',
                  header: 'IP',
                  render: (s) => (
                    <span
                      style={{
                        fontSize: 12,
                        color: tokens.color.textMuted,
                        fontFamily: tokens.font.mono,
                      }}
                    >
                      {s.ip ?? 'unknown'}
                    </span>
                  ),
                },
                {
                  key: 'last',
                  header: 'Last seen',
                  render: (s) => new Date(s.lastSeenAt).toLocaleString(),
                },
                {
                  key: 'created',
                  header: 'Signed in',
                  render: (s) => new Date(s.createdAt).toLocaleDateString(),
                },
              ]}
              rows={sessions}
              rowKey={(s) => s.id}
            />
          )}
        </Card>
      </section>

      <section>
        <SectionHeading
          eyebrow="Sign out"
          title="This device"
          description="End the current session on this browser only. Other devices stay signed in."
        />
        <Card>
          <Button type="button" variant="danger" onClick={() => void logout()}>
            Sign out
          </Button>
        </Card>
      </section>

      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}

function summarizeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown browser';
  if (/iPhone|iPad/.test(ua)) return 'iOS · Safari';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh.*Chrome/.test(ua)) return 'macOS · Chrome';
  if (/Macintosh.*Safari/.test(ua)) return 'macOS · Safari';
  if (/Macintosh/.test(ua)) return 'macOS';
  if (/Windows.*Chrome/.test(ua)) return 'Windows · Chrome';
  if (/Windows.*Firefox/.test(ua)) return 'Windows · Firefox';
  if (/Windows.*Edg\//.test(ua)) return 'Windows · Edge';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux.*Firefox/.test(ua)) return 'Linux · Firefox';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Browser';
}
