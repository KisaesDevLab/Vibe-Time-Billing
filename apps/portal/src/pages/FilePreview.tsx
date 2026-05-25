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

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, Card, EmptyState, SectionHeading, tokens } from '@vibe/ui';

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
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setLoaded(true);
      }
    })();
  }, [id]);

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
            <a href={url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
              <Button size="sm" variant="secondary">
                Download
              </Button>
            </a>
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
