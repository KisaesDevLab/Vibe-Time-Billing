// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// TR-4 / TR-8 — Portal tax-return viewer.
//
// Renders sidebar of (filtered) sections + cover note + access log +
// active shares rail. The PDF endpoint is wired but the renderer
// currently fall-closed-503s (no Puppeteer/pdf-lib in this env);
// we show a clear "preparing for viewing" message instead of breaking.
//
// Routes consumed:
//   GET /api/portal/tax/returns/:returnId/meta
//   GET /api/portal/tax/returns/:returnId/access-log
//   GET /api/portal/tax/returns/:returnId.pdf  (best-effort; may 503)

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, Card, Pill, tokens, useIsNarrow } from '@vibe/ui';

import { api, type ApiError } from '../api-client';
import { ProtectedPdfViewer } from '../components/ProtectedPdfViewer';

interface SectionRow {
  id: string;
  ordinal: number;
  depth: number;
  parentSectionId: string | null;
  title: string;
  kind: string;
  startPage: number;
  endPage: number;
  recipientName: string | null;
}

interface ShareRow {
  id: string;
  recipientName: string;
  recipientEmail: string;
  organization: string;
  status: string;
  viewCount: number;
  lastViewedAt: string | null;
  expiresAt: string;
}

interface ReturnMeta {
  return: {
    id: string;
    taxYear: number;
    formCode: string;
    jurisdiction: string;
    title: string;
    totalPages: number | null;
    releaseKind: 'ORIGINAL' | 'AMENDED' | 'SUPERSEDED';
  };
  release: {
    id: string;
    scope: 'FULL' | 'SELECTED';
    clientCanDownload: boolean;
    coverNote: string | null;
    releasedAt: string;
  };
  sections: SectionRow[];
  shares: ShareRow[];
}

interface AccessLogItem {
  id: string;
  event: string;
  actorKind: string;
  actorRef: string | null;
  at: string;
  metadata: Record<string, unknown> | null;
}

export function TaxReturnViewPage(): JSX.Element {
  const { returnId } = useParams<{ returnId: string }>();
  const narrow = useIsNarrow();
  const [meta, setMeta] = useState<ReturnMeta | null>(null);
  const [log, setLog] = useState<AccessLogItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!returnId) return;
    void (async () => {
      try {
        const m = await api<ReturnMeta>(`/api/portal/tax/returns/${returnId}/meta`);
        setMeta(m);
      } catch (err) {
        const apiErr = err as ApiError;
        setError(apiErr.message ?? 'failed');
      }
    })();
  }, [returnId, reloadKey]);

  useEffect(() => {
    if (!returnId) return;
    void (async () => {
      try {
        const r = await api<{ items: AccessLogItem[]; nextCursor: string | null }>(
          `/api/portal/tax/returns/${returnId}/access-log`,
        );
        setLog(r.items ?? []);
      } catch {
        // access log is optional; never block the viewer on it
      }
    })();
  }, [returnId]);

  const sortedSections = useMemo(() => {
    if (!meta) return [];
    return [...meta.sections].sort((a, b) => a.ordinal - b.ordinal);
  }, [meta]);

  if (error) {
    return (
      <div style={{ maxWidth: 700 }}>
        <Card title="Tax return unavailable">
          <p style={{ fontSize: 14, color: tokens.color.danger }}>
            {error === 'release_not_found'
              ? 'This return was not released to you, or the release has been revoked.'
              : `We couldn't load this return: ${error}.`}
          </p>
          <p style={{ marginTop: 12 }}>
            <Link to="/tax/returns" style={{ color: tokens.color.accent }}>
              ← Back to all returns
            </Link>
          </p>
        </Card>
      </div>
    );
  }

  if (!meta) {
    return (
      <div style={{ maxWidth: 700 }}>
        <Card title="Loading return…">
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>One moment.</p>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <div>
        <Link
          to="/tax/returns"
          style={{ color: tokens.color.accent, fontSize: 13, textDecoration: 'none' }}
        >
          ← All returns
        </Link>
      </div>

      <Card title={`${meta.return.taxYear} ${meta.return.formCode} — ${meta.return.jurisdiction}`}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <Pill tone={meta.return.releaseKind === 'AMENDED' ? 'warning' : 'accent'}>
            {meta.return.releaseKind}
          </Pill>
          {meta.release.scope === 'FULL' ? (
            <Pill tone="success">Full return</Pill>
          ) : (
            <Pill tone="neutral">Selected sections only</Pill>
          )}
          {meta.release.clientCanDownload ? (
            <Pill tone="success">Download enabled</Pill>
          ) : (
            <Pill tone="neutral">View only</Pill>
          )}
        </div>
        {meta.return.title && <p style={{ fontSize: 14, marginBottom: 8 }}>{meta.return.title}</p>}
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          Released {new Date(meta.release.releasedAt).toLocaleDateString()}
          {meta.return.totalPages != null && ` · ${meta.return.totalPages} pages total`}
        </p>
        {meta.release.coverNote && (
          <div
            style={{
              marginTop: tokens.space.md,
              padding: tokens.space.md,
              background: 'rgba(59, 130, 246, 0.08)',
              borderLeft: `4px solid ${tokens.color.accent}`,
              borderRadius: tokens.radius.sm,
              fontSize: 13,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                textTransform: 'uppercase',
                letterSpacing: 1,
                marginBottom: 4,
              }}
            >
              Note from your firm
            </div>
            {meta.release.coverNote}
          </div>
        )}
        {meta.release.clientCanDownload && (
          <div style={{ marginTop: tokens.space.md }}>
            <Button variant="secondary" size="sm" onClick={() => setShareOpen(true)}>
              Share with a 3rd party
            </Button>
          </div>
        )}
      </Card>

      {shareOpen && (
        <ShareWithThirdPartyDialog
          returnId={returnId ?? ''}
          scope={meta.release.scope}
          sectionIds={meta.release.scope === 'SELECTED' ? meta.sections.map((s) => s.id) : []}
          onClose={() => setShareOpen(false)}
          onShared={() => {
            setShareOpen(false);
            setReloadKey((k) => k + 1);
          }}
        />
      )}

      <div
        style={{
          display: 'grid',
          // Phone: single column with the DOCUMENT first — the desktop
          // two-column layout squeezed the return into an unreadable
          // ~150px thumbnail strip.
          gridTemplateColumns: narrow ? '1fr' : 'minmax(220px, 280px) 1fr',
          gap: tokens.space.lg,
        }}
      >
        <Card title="Sections" style={narrow ? { order: 2 } : undefined}>
          {sortedSections.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No sections available.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {sortedSections.map((s) => (
                <li
                  key={s.id}
                  style={{
                    paddingLeft: Math.max(0, s.depth - 1) * 12,
                    margin: '4px 0',
                    fontSize: 13,
                  }}
                >
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ color: tokens.color.text }}>{s.title}</span>
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      p{s.startPage}–{s.endPage}
                    </span>
                  </span>
                  {s.recipientName && (
                    <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      → {s.recipientName}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Document" style={narrow ? { order: 1 } : undefined}>
          {/* Rendered to <canvas> via pdf.js (not the native PDF viewer) so
              there's no download/print toolbar, the right-click menu is
              suppressed, and printing is blocked. The bytes are still the
              scoped, watermarked subset from the server. */}
          <ProtectedPdfViewer
            url={`/api/portal/tax/returns/${returnId}.pdf`}
            canDownload={meta.release.clientCanDownload}
            filename={`${meta.return.taxYear}-${meta.return.formCode}-${meta.return.jurisdiction}.pdf`}
          />
        </Card>
      </div>

      {meta.shares.length > 0 && (
        <Card title="Shared with">
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {meta.shares.map((s) => (
              <li
                key={s.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  padding: '6px 0',
                  borderBottom: `1px solid ${tokens.color.border}`,
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{s.recipientName}</div>
                  <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {s.recipientEmail}
                    {s.organization && ` · ${s.organization}`}
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 12, color: tokens.color.textMuted }}>
                  <div>
                    <Pill
                      tone={
                        s.status === 'active'
                          ? 'success'
                          : s.status === 'expired'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {s.status}
                    </Pill>
                  </div>
                  <div>
                    Viewed {s.viewCount}× ·{' '}
                    {s.lastViewedAt
                      ? `last ${new Date(s.lastViewedAt).toLocaleDateString()}`
                      : 'never'}
                  </div>
                  <div>expires {new Date(s.expiresAt).toLocaleDateString()}</div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Access history">
        {log.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            No activity recorded yet. Anyone who views this return will appear here.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {log.map((it) => (
              <li
                key={it.id}
                style={{
                  padding: '6px 0',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  fontSize: 13,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>
                    <strong>{it.event}</strong> · {it.actorKind.toLowerCase()}
                  </span>
                  <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                    {new Date(it.at).toLocaleString()}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShareWithThirdPartyDialog — lets the client forward their released
// return to an outside party (e.g. a lender). Creates a scoped share via
// the existing API and returns a copyable recipient link.
// ---------------------------------------------------------------------------

function ShareWithThirdPartyDialog({
  returnId,
  scope,
  sectionIds,
  onClose,
  onShared,
}: {
  returnId: string;
  scope: 'FULL' | 'SELECTED';
  sectionIds: string[];
  onClose: () => void;
  onShared: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [organization, setOrganization] = useState('');
  const [message, setMessage] = useState('');
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const dayNum = Number(days);
  const valid =
    name.trim().length > 0 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) &&
    dayNum >= 1 &&
    dayNum <= 90;

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ shareUrl: string }>(`/api/portal/tax/returns/${returnId}/shares`, {
        method: 'POST',
        body: JSON.stringify({
          recipientName: name.trim(),
          recipientEmail: email.trim(),
          organization: organization.trim(),
          role: role.trim() || 'Third party',
          accessLevel: 'view_only',
          scope,
          sectionIds,
          expiresAt: new Date(Date.now() + dayNum * 86400000).toISOString(),
          require2fa: false,
          verifyChannel: 'NONE',
          watermark: true,
          personalMessage: message.trim(),
        }),
      });
      setShareUrl(r.shareUrl);
    } catch (e) {
      const code = e instanceof Error ? e.message : 'failed';
      setErr(
        code === 'download_not_enabled'
          ? 'Sharing isn’t enabled for this return.'
          : code === 'rate_limit_24h'
            ? 'You’ve reached the share limit for today. Try again tomorrow.'
            : `Couldn’t create the share: ${code}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const field: CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    fontSize: 13,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 16,
        zIndex: 300,
      }}
    >
      {/* Internal scroller: with the phone keyboard open the visual viewport
          shrinks and a fixed overlay can't scroll — the submit button must
          stay reachable. */}
      <div style={{ width: 'min(560px, 94vw)', maxHeight: '90vh', overflowY: 'auto' }}>
        <Card title="Share with a 3rd party">
          {shareUrl ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <p style={{ fontSize: 13, margin: 0 }}>
                Share link created. Send this secure link to {name || 'your recipient'} — it’s
                view-only and watermarked.
              </p>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  padding: 8,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                }}
              >
                <code
                  style={{
                    flex: 1,
                    fontSize: 11,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {shareUrl}
                </code>
                <Button
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(shareUrl).then(() => setCopied(true));
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <div style={{ textAlign: 'right' }}>
                <Button size="sm" variant="secondary" onClick={onShared}>
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 8,
                }}
              >
                <input
                  style={field}
                  placeholder="Recipient name *"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <input
                  style={field}
                  placeholder="Recipient email *"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <input
                  style={field}
                  placeholder="Role (e.g. Lender)"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                />
                <input
                  style={field}
                  placeholder="Organization"
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                />
              </div>
              <textarea
                style={{ ...field, minHeight: 60, resize: 'vertical' }}
                placeholder="Personal message (optional)"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <label style={{ fontSize: 12, color: tokens.color.textMuted }}>
                Link expires in{' '}
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  style={{ ...field, width: 70, display: 'inline-block', padding: '4px 6px' }}
                />{' '}
                days
              </label>
              <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
                The recipient gets a view-only, watermarked copy of exactly what was shared with you
                {scope === 'SELECTED' ? ' (the selected sections only)' : ''}.
              </p>
              {err && <p style={{ fontSize: 12, color: tokens.color.danger, margin: 0 }}>{err}</p>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button size="sm" disabled={busy || !valid} onClick={() => void submit()}>
                  {busy ? 'Creating…' : 'Create share link'}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
