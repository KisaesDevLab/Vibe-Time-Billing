// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api, type ApiError } from '../api-client';

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
  const [meta, setMeta] = useState<ReturnMeta | null>(null);
  const [log, setLog] = useState<AccessLogItem[]>([]);
  const [pdfState, setPdfState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pdfErrMsg, setPdfErrMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  }, [returnId]);

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

  // Probe the rendered PDF so we can show a graceful message if the
  // renderer is unavailable, without garbling the bytes through the JSON
  // api() helper. On success the <iframe> below streams + renders it
  // (scoped to the released pages, watermarked).
  useEffect(() => {
    if (!returnId) return;
    let cancelled = false;
    setPdfState('loading');
    setPdfErrMsg(null);
    void (async () => {
      try {
        const res = await fetch(`/api/portal/tax/returns/${returnId}.pdf`, {
          credentials: 'same-origin',
        });
        if (cancelled) return;
        if (res.ok) {
          setPdfState('ready');
        } else {
          let msg = `status ${res.status}`;
          try {
            const b = (await res.json()) as { error?: string };
            if (b?.error) msg = b.error;
          } catch {
            /* non-JSON error body */
          }
          setPdfErrMsg(msg);
          setPdfState('error');
        }
      } catch (e) {
        if (cancelled) return;
        setPdfErrMsg(e instanceof Error ? e.message : 'failed');
        setPdfState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
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
      </Card>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(220px, 280px) 1fr',
          gap: tokens.space.lg,
        }}
      >
        <Card title="Sections">
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

        <Card title="Document">
          {pdfState === 'error' ? (
            <p style={{ fontSize: 13, color: tokens.color.danger }}>
              The document couldn&apos;t be loaded
              {pdfErrMsg ? ` (${pdfErrMsg})` : ''}. Please try again shortly or contact your firm.
            </p>
          ) : pdfState === 'loading' ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading document…</p>
          ) : (
            <div>
              {/* The PDF is rendered scoped to the released pages + watermarked.
                  #toolbar=0&navpanes=0 hides the browser PDF viewer's
                  download/print/rotate chrome so the portal stays view-only. */}
              <iframe
                title="Tax return document"
                src={`/api/portal/tax/returns/${returnId}.pdf#toolbar=0&navpanes=0`}
                style={{
                  width: '100%',
                  height: '80vh',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                }}
              />
              {meta.release.clientCanDownload ? (
                <div style={{ marginTop: tokens.space.sm }}>
                  <a
                    href={`/api/portal/tax/returns/${returnId}.pdf`}
                    download={`${meta.return.taxYear}-${meta.return.formCode}-${meta.return.jurisdiction}.pdf`}
                  >
                    <Button variant="secondary" size="sm">
                      Download PDF
                    </Button>
                  </a>
                </div>
              ) : (
                <p
                  style={{
                    fontSize: 11,
                    color: tokens.color.textMuted,
                    marginTop: tokens.space.sm,
                  }}
                >
                  This document is view-only.
                </p>
              )}
            </div>
          )}
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
