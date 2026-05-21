// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client files card. Two modes:
//   compact=true  — last 6 for the Home tab "Recent Files" card (this file)
//   compact=false — full Canopy-class manager (delegates to FileBrowser)

import { useEffect, useRef, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

import { FileBrowser } from './FileBrowser';

interface FileMeta {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedById: string | null;
  uploadedAt: string;
  status: string;
}

interface Props {
  clientId: string;
  compact?: boolean;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FilesCard({ clientId, compact = false }: Props): JSX.Element {
  // v2 Part 1 — full mode delegates to the Canopy-class FileBrowser.
  if (!compact) {
    return <FileBrowser scope="client" clientId={clientId} />;
  }
  return <FilesCardCompact clientId={clientId} />;
}

function FilesCardCompact({ clientId }: { clientId: string }): JSX.Element {
  const [items, setItems] = useState<FileMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: FileMeta[] }>(`/api/staff/clients/${clientId}/files`);
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function upload(file: File): Promise<void> {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      // Bypass api() to allow multipart Content-Type with boundary.
      const csrf = sessionStorage.getItem('__vibe_csrf');
      const res = await fetch(`/api/staff/clients/${clientId}/files`, {
        method: 'POST',
        headers: csrf ? { 'X-CSRF-Token': csrf } : {},
        body: formData,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `upload_${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload_failed');
    } finally {
      setUploading(false);
    }
  }

  const visible = items.slice(0, 6);

  return (
    <Card
      title={
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>Recent files</span>
          <Pill>{items.length}</Pill>
        </span>
      }
      action={
        <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Upload'}
        </Button>
      }
    >
      <input
        ref={fileInput}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          if (e.target) e.target.value = '';
        }}
      />
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}
      {visible.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No files uploaded yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {visible.map((f) => (
            <div
              key={f.id}
              style={{
                padding: 10,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <a
                  href={`/api/staff/clients/${clientId}/files/${f.id}/download`}
                  style={{ color: tokens.color.accent, textDecoration: 'none' }}
                >
                  {f.fileName}
                </a>
              </span>
              <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                {humanSize(f.sizeBytes)}
              </span>
              <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                {(f.uploadedAt ?? '').slice(0, 10) || '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
