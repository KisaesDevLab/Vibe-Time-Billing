// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP10 — Inline file preview (Build Plan §2.4, preview half).
//
// Clients open a file directly from the Files list and see its
// contents without downloading. Render strategy by mime:
//   application/pdf  → <iframe> pointing at the presigned URL.
//                       Browser native PDF viewer handles paging +
//                       zoom + print + download. No PDF.js dep.
//   image/*          → <img> tag with object-fit: contain.
//   anything else    → "Preview not available" + Download button.
//
// We deliberately don't add PDF.js — the browser's built-in viewer
// covers 99% of cases and adds zero bundle weight. If a firm needs
// per-page watermarking later, that's a follow-up.
//
// Privacy + audit: the existing /api/portal/files/:id/download
// endpoint already logs every access. The preview iframe hits the
// same endpoint via the same access-log path; no new audit surface.

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, Card, EmptyState, Input, Pill, SectionHeading, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface FileDetail {
  id: string;
  originalFilename: string;
  mimeType: string | null;
  sizeBytes: number;
  category: string | null;
  uploadedAt: string;
  modifiedAt: string;
  subfolderPath: string;
}

interface DownloadResp {
  url: string;
  filename: string;
}

interface ShareRow {
  id: string;
  accessLevel: string;
  expiresAt: string | null;
  note: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
}

interface CreatedShare {
  shareId: string;
  token: string;
  url: string;
  expiresAt: string | null;
  accessLevel: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function FilePreviewPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [file, setFile] = useState<FileDetail | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [createdShare, setCreatedShare] = useState<CreatedShare | null>(null);

  const loadShares = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      const r = await api<{ items: ShareRow[] }>(`/api/portal/files/${id}/shares`);
      setShares(r.items ?? []);
    } catch {
      // best-effort — share list is optional UX
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        // Resolve the file metadata from the list endpoint. The
        // /files/:id detail endpoint doesn't exist yet — we look up
        // by id from the full list, which is small (≤200) and cached
        // client-side via React state.
        const listResp = await api<{ items: FileDetail[] }>('/api/portal/files');
        const found = (listResp.items ?? []).find((f) => f.id === id);
        if (!found) {
          setError('File not found or you no longer have access.');
          return;
        }
        setFile(found);
        // Fetch the presigned URL. The endpoint logs access into
        // file_access_log via the existing path.
        const dl = await api<DownloadResp>(`/api/portal/files/${id}/download?format=json`);
        setUrl(dl.url);
        await loadShares();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setLoaded(true);
      }
    })();
  }, [id, loadShares]);

  if (!loaded) {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      </div>
    );
  }

  if (error || !file) {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto', display: 'grid', gap: tokens.space.md }}>
        <Link to="/files" style={{ color: tokens.color.accent, fontSize: 12 }}>
          ← Back to files
        </Link>
        <Card>
          <EmptyState
            icon="🚫"
            title="Cannot preview this file"
            body={error ?? 'The file may have been removed or your access revoked.'}
          />
        </Card>
      </div>
    );
  }

  const previewKind = pickPreviewKind(file.mimeType, file.originalFilename);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000, margin: '0 auto' }}>
      <Link
        to="/files"
        style={{ color: tokens.color.accent, fontSize: 12, textDecoration: 'none' }}
      >
        ← Back to files
      </Link>
      <SectionHeading
        title={file.originalFilename}
        description={`${formatBytes(file.sizeBytes)} · uploaded ${new Date(file.uploadedAt).toLocaleDateString()}${
          file.subfolderPath ? ` · ${file.subfolderPath}` : ''
        }`}
        action={
          url && (
            <div style={{ display: 'flex', gap: 6 }}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setCreatedShare(null);
                  setShareModalOpen(true);
                }}
              >
                Share
              </Button>
              <a href={url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                <Button size="sm" variant="secondary">
                  Download
                </Button>
              </a>
            </div>
          )
        }
      />
      <Card>
        {!url ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Resolving link…</p>
        ) : previewKind === 'pdf' ? (
          <iframe
            src={url}
            title={file.originalFilename}
            style={{
              width: '100%',
              height: '80vh',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
            }}
          />
        ) : previewKind === 'image' ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              padding: tokens.space.md,
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
            }}
          >
            <img
              src={url}
              alt={file.originalFilename}
              style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
            />
          </div>
        ) : (
          <EmptyState
            icon="📄"
            title="Preview not available"
            body={`This file is a ${file.mimeType ?? 'binary'} document and can't be shown inline. Use the Download button above to view it.`}
          />
        )}
      </Card>

      {shares.length > 0 && (
        <Card title={`Active share links (${shares.length})`}>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {shares.map((s) => (
              <li
                key={s.id}
                style={{
                  padding: tokens.space.sm,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 0, fontSize: 12 }}>
                  <div>
                    <Pill tone="accent">{s.accessLevel}</Pill>
                    {s.expiresAt && (
                      <span style={{ marginLeft: 8, color: tokens.color.textMuted }}>
                        expires {new Date(s.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <div style={{ color: tokens.color.textMuted, marginTop: 2 }}>
                    Created {new Date(s.createdAt).toLocaleDateString()} ·{' '}
                    {s.accessCount === 0
                      ? 'never opened'
                      : `opened ${s.accessCount}× ${s.lastAccessedAt ? `(last ${new Date(s.lastAccessedAt).toLocaleString()})` : ''}`}
                  </div>
                  {s.note && (
                    <div style={{ color: tokens.color.textMuted, marginTop: 2 }}>{s.note}</div>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    if (!window.confirm('Revoke this share link?')) return;
                    try {
                      await api(`/api/portal/files/shares/${s.id}/revoke`, {
                        method: 'POST',
                        body: '{}',
                      });
                      await loadShares();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'failed');
                    }
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {shareModalOpen && file && (
        <ShareLinkModal
          fileId={file.id}
          onClose={() => {
            setShareModalOpen(false);
            setCreatedShare(null);
            void loadShares();
          }}
          created={createdShare}
          onCreated={setCreatedShare}
        />
      )}
    </div>
  );
}

function ShareLinkModal({
  fileId,
  onClose,
  created,
  onCreated,
}: {
  fileId: string;
  onClose: () => void;
  created: CreatedShare | null;
  onCreated: (s: CreatedShare) => void;
}): JSX.Element {
  const [expires, setExpires] = useState<'1' | '7' | '30' | 'never'>('7');
  const [accessLevel, setAccessLevel] = useState<'view' | 'download'>('view');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { accessLevel };
      if (expires !== 'never') body['expiresInDays'] = Number(expires);
      if (note.trim()) body['note'] = note.trim();
      const r = await api<CreatedShare>(`/api/portal/files/${fileId}/shares`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onCreated(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
    } catch {
      // ignore — user can select manually
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.space.md,
      }}
    >
      <div
        style={{
          background: tokens.color.bg,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space.lg,
          maxWidth: 520,
          width: '100%',
        }}
      >
        <h2 id="share-modal-title" style={{ margin: 0, fontSize: 18 }}>
          Share this file
        </h2>
        {created ? (
          <>
            <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 8 }}>
              Send this link to whoever needs to see the file. Anyone with the link can open it
              until you revoke it
              {created.expiresAt ? ' or it expires.' : '.'}
            </p>
            <div
              style={{
                marginTop: tokens.space.md,
                padding: tokens.space.sm,
                background: tokens.color.surface,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                fontFamily: tokens.font.mono,
                fontSize: 12,
                wordBreak: 'break-all',
              }}
            >
              {created.url}
            </div>
            <p style={{ fontSize: 11, color: tokens.color.danger, marginTop: 8 }}>
              The link is shown only once. Copy it now — if you lose it, revoke this share and
              generate a new one.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <Button variant="secondary" onClick={() => void copy()}>
                Copy link
              </Button>
              <Button onClick={onClose}>Done</Button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 8 }}>
              Generate a link that lets someone without a portal account open this file.
            </p>
            <div style={{ display: 'grid', gap: 12, marginTop: tokens.space.md }}>
              <div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Expires
                </div>
                <select
                  value={expires}
                  onChange={(e) => setExpires(e.target.value as typeof expires)}
                  style={{
                    padding: '8px 10px',
                    fontSize: 13,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.surface,
                    color: tokens.color.text,
                    width: '100%',
                  }}
                >
                  <option value="1">24 hours</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="never">Never (until revoked)</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Access level
                </div>
                <select
                  value={accessLevel}
                  onChange={(e) => setAccessLevel(e.target.value as typeof accessLevel)}
                  style={{
                    padding: '8px 10px',
                    fontSize: 13,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.surface,
                    color: tokens.color.text,
                    width: '100%',
                  }}
                >
                  <option value="view">View only</option>
                  <option value="download">Allow download</option>
                </select>
              </div>
              <Input
                label="Note (optional, for your records)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. for Banker Bob"
              />
            </div>
            {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{err}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void create()} disabled={busy}>
                {busy ? 'Creating…' : 'Create link'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type PreviewKind = 'pdf' | 'image' | 'other';

export function pickPreviewKind(mime: string | null, filename: string): PreviewKind {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime?.startsWith('image/')) return 'image';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
  return 'other';
}
