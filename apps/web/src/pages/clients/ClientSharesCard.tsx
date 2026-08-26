// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client Files tab — "File sharing activity" card.
//
// Two things staff previously had no screen for, even though both were
// already being written to the database:
//
//   Shares          — every secure link sent out for one of this client's
//                     files, with delivery + recipient-side status. The
//                     Activity button opens that share's full trail
//                     (access code sent / verified / failed, the download
//                     itself, and every denial) from file_share_event.
//   Portal activity — what the CLIENT did with their own files inside the
//                     portal (file_access_log). Distinct from a share:
//                     no link, no code, they were signed in.

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Modal, Pill, Table, tokens, type TableColumn } from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';

interface ShareRow {
  id: string;
  fileId: string | null;
  filename: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  organization: string | null;
  accessLevel: 'view' | 'download';
  watermark: boolean;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  deliveredAt: string | null;
  accessCount: number;
  lastViewedAt: string | null;
}

interface ShareEvent {
  id: string;
  at: string;
  outcome: string;
  ip: string | null;
  userAgent: string | null;
}

interface PortalRow {
  id: string;
  at: string;
  fileId: string | null;
  filename: string | null;
  requestedStorageKey: string | null;
  outcome: string;
  ip: string | null;
  who: string | null;
}

// Plain-English label per recorded outcome. Unknown values fall through
// as-is rather than being hidden — a new outcome should still show up.
const SHARE_OUTCOME: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  allowed: { label: 'File opened / downloaded', tone: 'success' },
  otp_sent: { label: 'Access code emailed', tone: 'success' },
  otp_verified: { label: 'Access code verified', tone: 'success' },
  otp_failed: { label: 'Wrong access code', tone: 'warning' },
  otp_locked: { label: 'Locked out — too many attempts', tone: 'danger' },
  revoked_lockout: { label: 'Revoked after repeated failures', tone: 'danger' },
  denied_gated: { label: 'Blocked — code not verified', tone: 'warning' },
  denied_not_verified: { label: 'Blocked — code not verified', tone: 'warning' },
  denied_revoked: { label: 'Blocked — share revoked', tone: 'warning' },
  denied_expired: { label: 'Blocked — share expired', tone: 'warning' },
  denied_file_gone: { label: 'Blocked — file no longer available', tone: 'danger' },
};

const PORTAL_OUTCOME: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  allowed: { label: 'Downloaded from portal', tone: 'success' },
  denied_visibility: { label: 'Blocked — file not shared to portal', tone: 'warning' },
  denied_ownership: { label: 'Blocked — not their file', tone: 'danger' },
  denied_rate_limit: { label: 'Blocked — rate limited', tone: 'warning' },
  denied_not_found: { label: 'Blocked — file not found', tone: 'warning' },
  denied_pending: { label: 'Blocked — upload still in progress', tone: 'warning' },
  denied_deleted: { label: 'Blocked — file deleted', tone: 'warning' },
};

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function statusTone(s: ShareRow): 'success' | 'warning' | 'danger' | undefined {
  if (s.revokedAt) return 'danger';
  if (s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()) return 'warning';
  if (s.status === 'VIEWED') return 'success';
  return undefined;
}

function statusLabel(s: ShareRow): string {
  if (s.revokedAt) return 'Revoked';
  if (s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()) return 'Expired';
  return s.status === 'VIEWED' ? 'Opened' : 'Sent';
}

export function ClientSharesCard({ clientId }: { clientId: string }): JSX.Element | null {
  const canView = usePermission('storage:file:publish');
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [portal, setPortal] = useState<PortalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activityFor, setActivityFor] = useState<ShareRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([
        api<{ items: ShareRow[] }>(`/api/staff/files/client/${clientId}/shares`),
        api<{ items: PortalRow[] }>(`/api/staff/files/client/${clientId}/portal-activity`).catch(
          () => ({ items: [] as PortalRow[] }),
        ),
      ]);
      setShares(s.items ?? []);
      setPortal(p.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    if (canView) void load();
    else setLoading(false);
  }, [canView, load]);

  async function revoke(row: ShareRow): Promise<void> {
    if (!window.confirm(`Revoke the link sent to ${row.recipientEmail ?? 'this recipient'}?`)) {
      return;
    }
    setBusyId(row.id);
    try {
      await api(`/api/staff/files/shares/${row.id}/revoke`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'revoke_failed');
    } finally {
      setBusyId(null);
    }
  }

  // The card is permission-gated the same way the share action is; hiding
  // it entirely is less confusing than an empty card someone can't fill.
  if (!canView) return null;

  const shareCols: TableColumn<ShareRow>[] = [
    {
      key: 'file',
      mobile: 'title',
      header: 'File',
      render: (r) => r.filename ?? (r.fileId ? '(file removed)' : 'Multiple files'),
    },
    {
      key: 'recipient',
      mobile: 'field',
      header: 'Recipient',
      render: (r) => (
        <span>
          {r.recipientName ? `${r.recipientName} · ` : ''}
          {r.recipientEmail ?? '—'}
          {r.organization ? (
            <span style={{ color: tokens.color.textMuted }}> ({r.organization})</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'access',
      mobile: 'field',
      header: 'Access',
      render: (r) => (
        <span>
          {r.accessLevel === 'download' ? 'Download' : 'View only'}
          {r.watermark ? (
            <span style={{ color: tokens.color.textMuted }}> · watermarked</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'status',
      mobile: 'badge',
      header: 'Status',
      render: (r) => <Pill tone={statusTone(r)}>{statusLabel(r)}</Pill>,
    },
    {
      key: 'sent',
      mobile: 'meta',
      header: 'Sent',
      render: (r) => when(r.deliveredAt ?? r.createdAt),
    },
    {
      key: 'opened',
      mobile: 'field',
      header: 'Last opened',
      render: (r) =>
        r.lastViewedAt ? (
          <span>
            {when(r.lastViewedAt)}
            <span style={{ color: tokens.color.textMuted }}> ({r.accessCount}×)</span>
          </span>
        ) : (
          <span style={{ color: tokens.color.textMuted }}>Not yet opened</span>
        ),
    },
    { key: 'expires', mobile: 'field', header: 'Expires', render: (r) => when(r.expiresAt) },
    {
      key: 'actions',
      mobile: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Button size="sm" variant="ghost" onClick={() => setActivityFor(r)}>
            Activity
          </Button>
          {!r.revokedAt && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void revoke(r)}
              disabled={busyId === r.id}
            >
              {busyId === r.id ? 'Revoking…' : 'Revoke'}
            </Button>
          )}
        </span>
      ),
    },
  ];

  const portalCols: TableColumn<PortalRow>[] = [
    {
      key: 'file',
      mobile: 'title',
      header: 'File',
      render: (r) => r.filename ?? r.requestedStorageKey ?? '(file removed)',
    },
    { key: 'who', mobile: 'field', header: 'Who', render: (r) => r.who ?? 'Portal user' },
    {
      key: 'what',
      mobile: 'badge',
      header: 'What happened',
      render: (r) => {
        const o = PORTAL_OUTCOME[r.outcome];
        return <Pill tone={o?.tone}>{o?.label ?? r.outcome}</Pill>;
      },
    },
    { key: 'at', mobile: 'meta', header: 'When', render: (r) => when(r.at) },
    { key: 'ip', mobile: 'field', header: 'IP', render: (r) => r.ip ?? '—' },
  ];

  return (
    <>
      <Card
        title="File sharing activity"
        action={
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        }
      >
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}

        <SectionLabel>Secure links sent to outside recipients</SectionLabel>
        <Table<ShareRow>
          columns={shareCols}
          rows={shares}
          rowKey={(r) => r.id}
          empty="No files have been shared for this client yet."
        />

        <div style={{ marginTop: tokens.space.lg }}>
          <SectionLabel>Client portal activity</SectionLabel>
          <Table<PortalRow>
            columns={portalCols}
            rows={portal}
            rowKey={(r) => r.id}
            empty="No portal file views or downloads recorded for this client yet."
          />
        </div>
      </Card>

      {activityFor && (
        <ShareActivityDialog share={activityFor} onClose={() => setActivityFor(null)} />
      )}
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: tokens.color.textMuted,
        fontWeight: 600,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

/** Full recipient-side trail for one share. */
function ShareActivityDialog({
  share,
  onClose,
}: {
  share: ShareRow;
  onClose: () => void;
}): JSX.Element {
  const [events, setEvents] = useState<ShareEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ events: ShareEvent[] }>(`/api/staff/files/shares/${share.id}/events`);
        setEvents(r.events ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load_failed');
      } finally {
        setLoading(false);
      }
    })();
  }, [share.id]);

  return (
    <Modal title="Share activity" onClose={onClose} maxWidth={720}>
      <div style={{ display: 'grid', gap: 12 }}>
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '4px 16px',
            fontSize: 13,
            margin: 0,
          }}
        >
          <dt style={{ color: tokens.color.textMuted }}>File</dt>
          <dd style={{ margin: 0 }}>{share.filename ?? 'Multiple files'}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Recipient</dt>
          <dd style={{ margin: 0 }}>{share.recipientEmail ?? '—'}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Sent</dt>
          <dd style={{ margin: 0 }}>{when(share.deliveredAt ?? share.createdAt)}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Opened</dt>
          <dd style={{ margin: 0 }}>
            {share.lastViewedAt ? `${when(share.lastViewedAt)} (${share.accessCount}×)` : 'Not yet'}
          </dd>
        </dl>

        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
        ) : events.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            Nothing recorded yet — the recipient hasn&apos;t opened the link.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {events.map((e) => {
              const o = SHARE_OUTCOME[e.outcome];
              return (
                <div
                  key={e.id}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    alignItems: 'baseline',
                    borderTop: `1px solid ${tokens.color.border}`,
                    paddingTop: 6,
                    fontSize: 13,
                  }}
                >
                  <Pill tone={o?.tone}>{o?.label ?? e.outcome}</Pill>
                  <span style={{ color: tokens.color.textMuted }}>{when(e.at)}</span>
                  {e.ip && <span style={{ color: tokens.color.textMuted }}>· {e.ip}</span>}
                  {e.userAgent && (
                    <span
                      style={{
                        color: tokens.color.textMuted,
                        fontSize: 11,
                        flexBasis: '100%',
                        wordBreak: 'break-word',
                      }}
                    >
                      {e.userAgent}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
