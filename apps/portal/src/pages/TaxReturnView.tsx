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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api, type ApiError } from '../api-client';

// Lazy pdf.js loader (worker wired once). Same pattern as the staff
// FieldEditor so the worker asset is bundled by Vite.
const importPdfjs = () => import('pdfjs-dist');
let pdfjsPromise: ReturnType<typeof importPdfjs> | null = null;
function loadPdfjs(): ReturnType<typeof importPdfjs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await importPdfjs();
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

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
// ProtectedPdfViewer — renders the PDF to <canvas> via pdf.js (never the
// native browser viewer), so there's no download/print toolbar. We also
// suppress the right-click menu and hide the canvases from print output.
// Note: this stops casual save/print, not a determined screenshot.
// ---------------------------------------------------------------------------

function ProtectedPdfViewer({
  url,
  canDownload,
  filename,
}: {
  url: string;
  canDownload: boolean;
  filename: string;
}): JSX.Element {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setStatus('loading');
      setErrMsg(null);
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (cancelled) return;
        if (!res.ok) {
          let msg = `status ${res.status}`;
          try {
            const b = (await res.json()) as { error?: string };
            if (b?.error) msg = b.error;
          } catch {
            /* non-JSON body */
          }
          setErrMsg(msg);
          setStatus('error');
          return;
        }
        const data = new Uint8Array(await res.arrayBuffer());
        const pdfjs = await loadPdfjs();
        const pdf = await pdfjs.getDocument({ data }).promise;
        if (cancelled) return;
        const host = hostRef.current;
        if (!host) return;
        host.innerHTML = '';
        const RENDER_W = 1100;
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(2, RENDER_W / base.width);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.style.width = '100%';
          canvas.style.height = 'auto';
          canvas.style.display = 'block';
          canvas.style.margin = '0 auto 12px';
          canvas.style.boxShadow = '0 1px 6px rgba(0,0,0,0.3)';
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          host.appendChild(canvas);
        }
        if (!cancelled) setStatus('ready');
      } catch (e) {
        if (!cancelled) {
          setErrMsg(e instanceof Error ? e.message : 'render_failed');
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Block Ctrl/Cmd+P while this viewer is mounted.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (status === 'error') {
    return (
      <p style={{ fontSize: 13, color: tokens.color.danger }}>
        The document couldn&apos;t be loaded{errMsg ? ` (${errMsg})` : ''}. Please try again shortly
        or contact your firm.
      </p>
    );
  }

  return (
    <div>
      {/* Hide the rendered document from any print output. */}
      <style>{`@media print { .vibe-pdf-protected { display: none !important; } }`}</style>
      {status === 'loading' && (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading document…</p>
      )}
      <div
        ref={hostRef}
        className="vibe-pdf-protected"
        onContextMenu={(e) => e.preventDefault()}
        style={{
          maxHeight: '80vh',
          overflowY: 'auto',
          background: '#525659',
          padding: 12,
          borderRadius: tokens.radius.sm,
          userSelect: 'none',
        }}
      />
      {canDownload ? (
        <div style={{ marginTop: tokens.space.sm }}>
          <a href={url} download={filename}>
            <Button variant="secondary" size="sm">
              Download PDF
            </Button>
          </a>
        </div>
      ) : (
        <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: tokens.space.sm }}>
          This document is view-only — saving and printing are disabled.
        </p>
      )}
    </div>
  );
}
