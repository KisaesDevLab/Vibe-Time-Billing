// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client-detail Files tab (Phase 10 of FILE_MANAGER_ADDENDUM.md).
//
// Three sub-sections + a rename modal + an upload dialog.
//
//   Storage folder card  — path, status, last synced, Rename/Refresh.
//   File browser         — subfolder tree (derived from grouping
//                          files.subfolder_path strings) + table.
//   Toolbar              — visibility filter, search, bulk actions.
//   Upload dialog        — subfolder picker + visibility default
//                          preview.
//   Rename modal         — opens an SSE stream against
//                          /api/staff/clients/:id/folder/progress so
//                          the user sees per-phase progress and the
//                          object count tick up.
//
// Permission gates rely on usePermission(); buttons are disabled with
// a tooltip when missing rather than hidden.

import { useEffect, useMemo, useRef, useState } from 'react';

import { Button, Card, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';

interface FileRow {
  id: string;
  subfolderPath: string;
  originalFilename: string;
  storageKey: string;
  mimeType: string | null;
  sizeBytes: number;
  sha256: string | null;
  etag: string | null;
  category: string | null;
  source: 'app' | 'explorer' | 'generated';
  visibility: 'private' | 'client_visible';
  uploadedAt: string;
  modifiedAt: string;
  pendingUpload: boolean;
}

interface ListResponse {
  items: FileRow[];
  unbound?: boolean;
  clientFolderId?: string;
  storagePath?: string;
  status?: 'active' | 'renaming' | 'missing' | 'conflict' | 'orphan';
  lastSyncedAt?: string | null;
}

type VisibilityFilter = 'all' | 'private' | 'client_visible';

const CATEGORIES = [
  { value: 'invoice', label: 'Invoice' },
  { value: 'engagement_letter', label: 'Engagement letter' },
  { value: 'receipt', label: 'Receipt' },
  { value: 'time_entry_support', label: 'Time entry support' },
  { value: 'correspondence', label: 'Correspondence' },
  { value: 'other', label: 'Other' },
] as const;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export function ClientFilesTab({ clientId }: { clientId: string }): JSX.Element {
  const canView = usePermission('storage:folder:view');
  const canEdit = usePermission('storage:folder:edit');
  const canRename = usePermission('storage:folder:rename');
  const canPublish = usePermission('storage:file:publish');
  const canUnpublish = usePermission('storage:file:unpublish');

  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedSubfolder, setSelectedSubfolder] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [uploadOpen, setUploadOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);

  async function load(): Promise<void> {
    setError(null);
    try {
      const r = await api<ListResponse>(`/api/staff/clients/${clientId}/files`);
      setData(r);
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    }
  }

  useEffect(() => {
    if (canView) void load();
    // load is recreated each render via closure over local state setters;
    // listing the actual identity-stable deps keeps the lint clean.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, canView]);

  const subfolders = useMemo(() => {
    if (!data?.items) return [] as string[];
    return Array.from(new Set(data.items.map((f) => f.subfolderPath))).sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data?.items) return [] as FileRow[];
    const needle = search.trim().toLowerCase();
    return data.items.filter((f) => {
      if (selectedSubfolder !== null && f.subfolderPath !== selectedSubfolder) return false;
      if (visibilityFilter !== 'all' && f.visibility !== visibilityFilter) return false;
      if (needle && !f.originalFilename.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data, search, selectedSubfolder, visibilityFilter]);

  async function toggleVisibility(file: FileRow): Promise<void> {
    const target = file.visibility === 'private' ? 'client_visible' : 'private';
    const requiredPerm = target === 'client_visible' ? canPublish : canUnpublish;
    if (!requiredPerm) {
      setError(`Need storage:file:${target === 'client_visible' ? 'publish' : 'unpublish'}`);
      return;
    }
    // Optimistic UI — flip locally, then call the API; revert on error.
    setData((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((r) => (r.id === file.id ? { ...r, visibility: target } : r)),
          }
        : prev,
    );
    try {
      await api(`/api/staff/files/${file.id}/visibility`, {
        method: 'PATCH',
        body: JSON.stringify({ visibility: target }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'visibility_failed');
      await load();
    }
  }

  async function bulkSetVisibility(target: 'private' | 'client_visible'): Promise<void> {
    if (selectedIds.size === 0) return;
    setBusy(true);
    try {
      await api('/api/staff/files/bulk-visibility', {
        method: 'POST',
        body: JSON.stringify({
          fileIds: Array.from(selectedIds),
          visibility: target,
        }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'bulk_visibility_failed');
    } finally {
      setBusy(false);
    }
  }

  async function download(file: FileRow): Promise<void> {
    try {
      const r = await api<{ url: string; filename: string }>(
        `/api/staff/files/${file.id}/download-url`,
      );
      // mock-presign:// URLs aren't directly fetchable; for dev we'd
      // need a separate translator. In a normal HTTPS deployment B2
      // serves the body straight from this URL.
      if (r.url.startsWith('http://') || r.url.startsWith('https://')) {
        window.open(r.url, '_blank', 'noopener');
        return;
      }
      setError('Mock storage download not supported in browser. Use B2 in production.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'download_failed');
    }
  }

  function toggleSelect(id: string): void {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  if (!canView) {
    return (
      <Card title="Files">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          You do not have permission to view this client&apos;s files.
        </p>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card title="Files">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          {error ?? 'Loading…'}
        </p>
      </Card>
    );
  }

  if (data.unbound) {
    return (
      <Card title="Files">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          This client is not bound to a storage folder yet. Visit{' '}
          <a href="/admin/storage">Storage Onboarding</a> to bind one.
        </p>
      </Card>
    );
  }

  const statusTone =
    data.status === 'active' ? 'success' : data.status === 'renaming' ? 'warning' : 'danger';

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      {error && (
        <Card>
          <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>
        </Card>
      )}

      <Card title="Storage folder">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            <code style={{ fontFamily: tokens.font.mono }}>{data.storagePath}</code>
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                fontSize: 12,
                color: tokens.color.textMuted,
              }}
            >
              <Pill tone={statusTone}>{data.status}</Pill>
              <span>Last synced: {formatTimestamp(data.lastSyncedAt ?? null)}</span>
              <span>·</span>
              <span>{data.items.length} files</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => void load()} disabled={busy}>
              Refresh
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !canRename || data.status !== 'active'}
              title={
                !canRename
                  ? 'Needs storage:folder:rename'
                  : data.status !== 'active'
                    ? `Folder is ${data.status} — resolve first`
                    : undefined
              }
              onClick={() => setRenameOpen(true)}
            >
              Rename folder
            </Button>
            <Button
              variant="primary"
              disabled={!canEdit || data.status !== 'active'}
              title={
                !canEdit
                  ? 'Needs storage:folder:edit'
                  : data.status !== 'active'
                    ? `Folder is ${data.status}`
                    : undefined
              }
              onClick={() => setUploadOpen(true)}
            >
              Upload
            </Button>
          </div>
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: tokens.space.lg }}>
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
              All ({data.items.length})
            </button>
            {subfolders.map((sf) => {
              const count = data.items.filter((f) => f.subfolderPath === sf).length;
              const label = sf === '' ? '(folder root)' : sf;
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
                    fontFamily: tokens.font.mono,
                  }}
                >
                  {label} <span style={{ color: tokens.color.textMuted }}>({count})</span>
                </button>
              );
            })}
          </div>
        </Card>

        <Card>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              marginBottom: 8,
              flexWrap: 'wrap',
            }}
          >
            <Input
              placeholder="Search filename…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: 200 }}
            />
            <Combobox
              value={visibilityFilter}
              onChange={(v) => setVisibilityFilter(v as VisibilityFilter)}
              options={[
                { value: 'all', label: 'All visibility' },
                { value: 'private', label: 'Private only' },
                { value: 'client_visible', label: 'Client visible only' },
              ]}
            />
            {selectedIds.size > 0 && (
              <>
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  {selectedIds.size} selected
                </span>
                <Button
                  disabled={busy || !canPublish}
                  title={!canPublish ? 'Needs storage:file:publish' : undefined}
                  onClick={() => void bulkSetVisibility('client_visible')}
                >
                  Publish
                </Button>
                <Button
                  disabled={busy || !canUnpublish}
                  title={!canUnpublish ? 'Needs storage:file:unpublish' : undefined}
                  onClick={() => void bulkSetVisibility('private')}
                >
                  Make private
                </Button>
              </>
            )}
          </div>

          <Table<FileRow>
            rows={filtered}
            rowKey={(r) => r.id}
            empty="No files match the current filter."
            columns={[
              {
                key: 'select',
                header: '',
                render: (r) => (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(r.id)}
                    onChange={() => toggleSelect(r.id)}
                  />
                ),
              },
              {
                key: 'name',
                header: 'Name',
                render: (r) => (
                  <span style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>
                    {r.originalFilename}
                    {r.pendingUpload && <Pill tone="warning">pending</Pill>}
                  </span>
                ),
              },
              {
                key: 'subfolder',
                header: 'Subfolder',
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
                render: (r) => formatTimestamp(r.modifiedAt),
              },
              {
                key: 'visibility',
                header: 'Visibility',
                render: (r) => (
                  <button
                    type="button"
                    onClick={() => void toggleVisibility(r)}
                    title={`Flip to ${r.visibility === 'private' ? 'client_visible' : 'private'}`}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    <Pill tone={r.visibility === 'client_visible' ? 'success' : 'neutral'}>
                      {r.visibility === 'client_visible' ? '👁 visible' : '🔒 private'}
                    </Pill>
                  </button>
                ),
              },
              {
                key: 'download',
                header: '',
                render: (r) => (
                  <Button onClick={() => void download(r)} disabled={r.pendingUpload}>
                    Download
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      </div>

      {uploadOpen && (
        <UploadDialog
          clientId={clientId}
          subfolders={subfolders}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            void load();
          }}
        />
      )}
      {renameOpen && data.storagePath && (
        <RenameDialog
          clientId={clientId}
          currentPath={data.storagePath}
          onClose={() => setRenameOpen(false)}
          onDone={() => {
            setRenameOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload dialog
// ---------------------------------------------------------------------------

interface UploadDialogProps {
  clientId: string;
  subfolders: string[];
  onClose: () => void;
  onUploaded: () => void;
}

function UploadDialog({
  clientId,
  subfolders,
  onClose,
  onUploaded,
}: UploadDialogProps): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<string>('other');
  const [subfolderOverride, setSubfolderOverride] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'reserving' | 'uploading' | 'completing'>('idle');

  async function go(): Promise<void> {
    if (!file) {
      setError('Pick a file first.');
      return;
    }
    setError(null);
    setPhase('reserving');
    try {
      // 1) Reserve a slot — server picks subfolder by category if we don't supply one.
      const reserve = await api<{
        fileId: string;
        storageKey: string;
        uploadUrl: string;
        visibility: 'private' | 'client_visible';
      }>(`/api/staff/clients/${clientId}/files`, {
        method: 'POST',
        body: JSON.stringify({
          category,
          subfolderPath: subfolderOverride || undefined,
          originalFilename: file.name,
          sizeBytes: file.size,
          mimeType: file.type || undefined,
        }),
      });

      // 2) Upload the body. mock-presign:// URLs route through the
      //    dev-only translator so the browser doesn't try to fetch
      //    an unsupported scheme.
      setPhase('uploading');
      if (reserve.uploadUrl.startsWith('mock-presign://')) {
        const buf = await file.arrayBuffer();
        const b64 = bufferToBase64(buf);
        await api('/api/staff/admin/storage/upload-mock', {
          method: 'POST',
          body: JSON.stringify({
            url: reserve.uploadUrl,
            contentBase64: b64,
            contentType: file.type || 'application/octet-stream',
          }),
        });
      } else {
        const r = await fetch(reserve.uploadUrl, {
          method: 'PUT',
          headers: file.type ? { 'Content-Type': file.type } : undefined,
          body: file,
        });
        if (!r.ok) throw new Error(`upload_failed_${r.status}`);
      }

      // 3) Confirm.
      setPhase('completing');
      await api(`/api/staff/files/${reserve.fileId}/complete`, {
        method: 'POST',
        body: '{}',
      });

      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload_failed');
      setPhase('idle');
    }
  }

  return (
    <ModalShell title="Upload file" onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        <label style={{ fontSize: 12, color: tokens.color.textMuted, display: 'block' }}>
          File
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ display: 'block', marginTop: 4 }}
          />
        </label>
        <div>
          <span
            style={{
              fontSize: 12,
              color: tokens.color.textMuted,
              display: 'block',
              marginBottom: 4,
            }}
          >
            Category
          </span>
          <Combobox
            value={category}
            onChange={setCategory}
            options={CATEGORIES.map((c) => ({ value: c.value, label: c.label }))}
          />
        </div>
        <div>
          <span
            style={{
              fontSize: 12,
              color: tokens.color.textMuted,
              display: 'block',
              marginBottom: 4,
            }}
          >
            Subfolder (optional — overrides category routing)
          </span>
          <Combobox
            value={subfolderOverride}
            onChange={setSubfolderOverride}
            placeholder="(use category default)"
            options={[
              { value: '', label: '(use category default)' },
              ...subfolders.filter((s) => s !== '').map((s) => ({ value: s, label: s })),
            ]}
          />
        </div>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{error}</p>}
        {phase !== 'idle' && (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
            {phase === 'reserving' && 'Reserving slot…'}
            {phase === 'uploading' && 'Uploading body…'}
            {phase === 'completing' && 'Confirming…'}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={phase !== 'idle'}>
            Cancel
          </Button>
          <Button onClick={() => void go()} disabled={phase !== 'idle' || !file} variant="primary">
            Upload
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Rename dialog (subscribes to SSE progress)
// ---------------------------------------------------------------------------

interface RenameDialogProps {
  clientId: string;
  currentPath: string;
  onClose: () => void;
  onDone: () => void;
}

interface ProgressFrame {
  phase: string;
  total?: number;
  done?: number;
  message?: string;
}

function RenameDialog({ clientId, currentPath, onClose, onDone }: RenameDialogProps): JSX.Element {
  const currentName = currentPath.replace(/\/$/, '').split('/').pop() ?? '';
  const [newName, setNewName] = useState(currentName);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  async function go(): Promise<void> {
    if (!newName.trim() || newName.trim() === currentName) {
      setError('Pick a different name.');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      // Open the SSE channel BEFORE enqueueing so the first preflight
      // event isn't lost. The browser auto-attaches the cookie.
      const es = new EventSource(`/api/staff/clients/${clientId}/folder/progress`);
      esRef.current = es;
      es.addEventListener('progress', (ev) => {
        try {
          const frame = JSON.parse((ev as MessageEvent).data) as ProgressFrame;
          setProgress(frame);
          if (frame.phase === 'complete') {
            es.close();
            onDone();
          } else if (frame.phase === 'failed') {
            setError(frame.message ?? 'Rename failed');
            setRunning(false);
            es.close();
          }
        } catch {
          /* ignore parse errors */
        }
      });
      es.addEventListener('error', () => {
        // SSE error events can fire on retry; don't tear down unless
        // the server has finished or failed (we handle that above).
      });

      // Now enqueue the rename.
      await api(`/api/staff/clients/${clientId}/folder/rename`, {
        method: 'POST',
        body: JSON.stringify({ newName: newName.trim() }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'rename_failed');
      setRunning(false);
      esRef.current?.close();
    }
  }

  return (
    <ModalShell title="Rename storage folder" onClose={running ? undefined : onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Current path: <code>{currentPath}</code>
        </div>
        <Input
          label="New folder name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          disabled={running}
        />
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{error}</p>}
        {progress && (
          <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
            Phase: <strong>{progress.phase}</strong>
            {progress.total !== undefined && progress.done !== undefined && (
              <>
                {' '}
                · {progress.done} / {progress.total}
              </>
            )}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button onClick={() => void go()} disabled={running} variant="primary">
            Rename
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Lightweight modal shell — the existing UI kit doesn't ship one yet.
// ---------------------------------------------------------------------------

interface ModalShellProps {
  title: string;
  onClose?: () => void;
  children: React.ReactNode;
}

function ModalShell({ title, onClose, children }: ModalShellProps): JSX.Element {
  // Escape closes when allowed (matches the X button behaviour).
  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      {onClose && (
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        />
      )}
      <div
        style={{
          background: tokens.color.surface,
          borderRadius: tokens.radius.md,
          padding: 20,
          minWidth: 420,
          maxWidth: 640,
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browser-safe binary → base64 helper. atob/btoa choke on non-Latin1
// bytes; build the base64 string in 8KB chunks.
// ---------------------------------------------------------------------------

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
