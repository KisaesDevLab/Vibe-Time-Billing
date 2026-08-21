// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Portal Files page (Phase 11 of FILE_MANAGER_ADDENDUM.md).
//
// Lists the active client's client_visible files grouped by subfolder.
// Each row carries a Download button that calls
// GET /api/portal/files/:id/download?format=json to fetch a 5-minute
// presigned URL and opens it in a new tab. The endpoint logs every
// access to file_access_log with outcome=allowed; staff see the
// timeline on the staff client-detail Files tab.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, Pill, Table, tokens, useIsNarrow } from '@vibe/ui';

import { api } from '../api-client';
import { FileCardList } from '../components/FileCardList';

interface FileRow {
  id: string;
  subfolderPath: string;
  originalFilename: string;
  mimeType: string | null;
  sizeBytes: number;
  category: string | null;
  uploadedAt: string;
  modifiedAt: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fileTypeIcon(mime: string | null, name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (mime?.startsWith('image/')) return '🖼';
  if (mime === 'application/pdf' || ext === 'pdf') return '📕';
  if (mime === 'application/zip' || ext === 'zip') return '🗜';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (['ppt', 'pptx'].includes(ext)) return '📈';
  if (['txt', 'md'].includes(ext)) return '📄';
  return '📁';
}

function categoryLabel(cat: string | null): string | null {
  if (!cat) return null;
  switch (cat) {
    case 'invoice':
      return 'Invoice';
    case 'engagement_letter':
      return 'Engagement letter';
    case 'receipt':
      return 'Receipt';
    case 'time_entry_support':
      return 'Supporting docs';
    case 'correspondence':
      return 'Correspondence';
    default:
      return cat;
  }
}

export function FilesPage(): JSX.Element {
  const [items, setItems] = useState<FileRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedSubfolder, setSelectedSubfolder] = useState<string | null>(null);
  const narrow = useIsNarrow();

  async function load(): Promise<void> {
    setError(null);
    try {
      const r = await api<{ items: FileRow[] }>('/api/portal/files');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const subfolders = useMemo(() => {
    return Array.from(new Set(items.map((f) => f.subfolderPath))).sort();
  }, [items]);

  const filtered = useMemo(() => {
    if (selectedSubfolder === null) return items;
    return items.filter((f) => f.subfolderPath === selectedSubfolder);
  }, [items, selectedSubfolder]);

  async function download(file: FileRow): Promise<void> {
    setBusy(file.id);
    setError(null);
    try {
      const r = await api<{ url: string; filename: string }>(
        `/api/portal/files/${file.id}/download?format=json`,
      );
      if (r.url.startsWith('http://') || r.url.startsWith('https://')) {
        window.open(r.url, '_blank', 'noopener');
      } else {
        setError('Download URL not supported in this environment.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'download_failed');
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0 && !error) {
    return (
      <div style={{ display: 'grid', gap: tokens.space.lg }}>
        <DocumentRequestsSection />
        <Card title="Files">
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No files have been shared with you yet.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      {error && (
        <Card>
          <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>
        </Card>
      )}

      <DocumentRequestsSection />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? '1fr' : '220px 1fr',
          gap: tokens.space.lg,
        }}
      >
        <Card title="Folders">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <button
              type="button"
              onClick={() => setSelectedSubfolder(null)}
              style={{
                textAlign: 'left',
                padding: '6px 10px',
                borderRadius: tokens.radius.sm,
                background: selectedSubfolder === null ? tokens.color.accentMuted : 'transparent',
                color: selectedSubfolder === null ? tokens.color.accent : tokens.color.text,
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              All ({items.length})
            </button>
            {subfolders.map((sf) => {
              const count = items.filter((f) => f.subfolderPath === sf).length;
              const label = sf === '' ? '(top folder)' : sf;
              return (
                <button
                  key={sf || '__root__'}
                  type="button"
                  onClick={() => setSelectedSubfolder(sf)}
                  style={{
                    textAlign: 'left',
                    padding: '6px 10px',
                    borderRadius: tokens.radius.sm,
                    background: selectedSubfolder === sf ? tokens.color.accentMuted : 'transparent',
                    color: selectedSubfolder === sf ? tokens.color.accent : tokens.color.text,
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                >
                  {label} <span style={{ color: tokens.color.textMuted }}>({count})</span>
                </button>
              );
            })}
          </div>
        </Card>

        <Card title={`Files (${filtered.length})`}>
          {narrow ? (
            <FileCardList
              rows={filtered.map((r) => ({
                id: r.id,
                originalFilename: r.originalFilename,
                sizeBytes: r.sizeBytes,
                mimeType: r.mimeType,
                uploadedAt: r.modifiedAt,
                categoryLabel: categoryLabel(r.category),
                icon: fileTypeIcon(r.mimeType, r.originalFilename),
                downloadDisabled: busy === r.id,
              }))}
              onDownload={(id) => {
                const row = filtered.find((r) => r.id === id);
                if (row) void download(row);
              }}
              empty={
                <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
                  No files in this folder.
                </p>
              }
            />
          ) : (
            <Table<FileRow>
              rows={filtered}
              rowKey={(r) => r.id}
              empty="No files in this folder."
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  render: (r) => (
                    <Link
                      to={`/files/${r.id}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        color: tokens.color.accent,
                        textDecoration: 'none',
                      }}
                    >
                      <span aria-hidden style={{ fontSize: 16 }}>
                        {fileTypeIcon(r.mimeType, r.originalFilename)}
                      </span>
                      <span style={{ fontSize: 13 }}>{r.originalFilename}</span>
                    </Link>
                  ),
                },
                {
                  key: 'category',
                  header: 'Category',
                  render: (r) => {
                    const label = categoryLabel(r.category);
                    return label ? <Pill tone="neutral">{label}</Pill> : <span>—</span>;
                  },
                },
                {
                  key: 'subfolder',
                  header: 'Folder',
                  render: (r) => (
                    <span
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 11,
                        color: tokens.color.textMuted,
                      }}
                    >
                      {r.subfolderPath || '(root)'}
                    </span>
                  ),
                },
                { key: 'size', header: 'Size', render: (r) => formatBytes(r.sizeBytes) },
                {
                  key: 'modified',
                  header: 'Modified',
                  render: (r) => new Date(r.modifiedAt).toLocaleString(),
                },
                {
                  key: 'download',
                  header: '',
                  render: (r) => (
                    <Button size="sm" onClick={() => void download(r)} disabled={busy === r.id}>
                      {busy === r.id ? 'Opening…' : 'Download'}
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 0219 — document requests. The firm asks for a list of documents; each
// item gets an upload control here. Files upload as base64 through
// POST /api/portal/document-requests/items/:itemId/upload (20MB cap) and
// land privately in the firm's folder for staff review.
// ---------------------------------------------------------------------------

interface RequestItem {
  id: string;
  label: string;
  status: 'PENDING' | 'UPLOADED';
  uploadedAt: string | null;
}

interface DocumentRequest {
  id: string;
  title: string;
  note: string | null;
  createdAt: string;
  items: RequestItem[];
}

const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function DocumentRequestsSection(): JSX.Element | null {
  const [requests, setRequests] = useState<DocumentRequest[] | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const r = await api<{ items: DocumentRequest[] }>('/api/portal/document-requests');
      setRequests(r.items ?? []);
    } catch {
      // Requests are supplementary — a load failure must not break Files.
      setRequests([]);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function uploadFor(item: RequestItem, file: File): Promise<void> {
    if (file.size > UPLOAD_MAX_BYTES) {
      setError(`"${file.name}" is larger than the 20 MB upload limit.`);
      return;
    }
    setBusyItem(item.id);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      await api(`/api/portal/document-requests/items/${item.id}/upload`, {
        method: 'POST',
        body: JSON.stringify({
          originalFilename: file.name,
          mimeType: file.type || undefined,
          contentBase64: bufferToBase64(buf),
        }),
      });
      await load();
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'file_too_large'
          ? `"${file.name}" is larger than the 20 MB upload limit.`
          : 'Upload failed — please try again or contact us.',
      );
    } finally {
      setBusyItem(null);
    }
  }

  if (!requests || requests.length === 0) return null;

  return (
    <Card title="Documents we need from you">
      {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
      <div style={{ display: 'grid', gap: 14 }}>
        {requests.map((r) => {
          const done = r.items.filter((i) => i.status === 'UPLOADED').length;
          return (
            <div key={r.id}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <strong style={{ fontSize: 14, flex: 1 }}>{r.title}</strong>
                <Pill tone={done === r.items.length ? 'success' : 'warning'}>
                  {done}/{r.items.length} uploaded
                </Pill>
              </div>
              {r.note && (
                <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: '0 0 8px' }}>
                  {r.note}
                </p>
              )}
              <div style={{ display: 'grid', gap: 6 }}>
                {r.items.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: 'flex',
                      gap: 10,
                      alignItems: 'center',
                      padding: '8px 10px',
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.sm,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span style={{ width: 16, fontSize: 14 }}>
                      {item.status === 'UPLOADED' ? '✅' : '📄'}
                    </span>
                    <span style={{ flex: 1, fontSize: 13, minWidth: 160 }}>{item.label}</span>
                    {item.status === 'UPLOADED' ? (
                      <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                        Received{' '}
                        {item.uploadedAt ? new Date(item.uploadedAt).toLocaleDateString() : ''}
                      </span>
                    ) : (
                      <label
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 13,
                          cursor: busyItem ? 'wait' : 'pointer',
                          color: tokens.color.accent,
                          fontWeight: 600,
                        }}
                      >
                        {busyItem === item.id ? 'Uploading…' : 'Upload'}
                        <input
                          type="file"
                          disabled={busyItem !== null}
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (f) void uploadFor(item, f);
                          }}
                        />
                      </label>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
