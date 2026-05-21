// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Main file-manager canvas (v2 Part 1). Composes the folder tree,
// inbox sidebar, file table with bulk actions, the Add dropdown, and
// the share / template-picker modals.
//
// Backed by the per-client (/api/staff/clients/:id/files) or internal
// (/api/staff/internal-files) endpoints depending on `scope`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

import { AddDropdown } from './AddDropdown';
import { BulkActionsBar } from './BulkActionsBar';
import { FileInboxSidebar } from './FileInboxSidebar';
import { FolderTemplatePicker } from './FolderTemplatePicker';
import { FolderTree, type Folder } from './FolderTree';
import { ShareModal } from './ShareModal';
import { VisibilityToggle } from './VisibilityToggle';

interface FileRow {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedById: string | null;
  uploadedAt: string;
  status: string;
  folderId: string | null;
  externalUrl: string | null;
  visibleInPortal: boolean;
  isInbox: boolean;
}

interface Props {
  scope: 'client' | 'internal';
  clientId?: string;
  /** Optional filter: only show files uploaded by this user. */
  uploadedById?: string;
}

type SortKey = 'name' | 'uploadedAt' | 'sizeBytes' | 'visible';
type SortDir = 'asc' | 'desc';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileBrowser({ scope, clientId, uploadedById }: Props): JSX.Element {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null | 'root' | 'inbox'>(
    'root',
  );
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('uploadedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [shareOpen, setShareOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);

  const baseUrl =
    scope === 'internal' ? '/api/staff/internal-files' : `/api/staff/clients/${clientId}/files`;
  const folderUrl =
    scope === 'internal'
      ? '/api/staff/internal-files/folders'
      : `/api/staff/clients/${clientId}/folders`;

  const loadFolders = useCallback(async (): Promise<void> => {
    if (scope === 'client' && !clientId) return;
    try {
      const path = scope === 'internal' ? '/api/staff/internal-files/folders/list' : folderUrl;
      const r = await api<{ items: Folder[] }>(path);
      setFolders(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }, [scope, clientId, folderUrl]);

  const loadFiles = useCallback(async (): Promise<void> => {
    if (scope === 'client' && !clientId) return;
    try {
      const params = new URLSearchParams();
      if (selectedFolderId === 'inbox') params.set('inbox', 'true');
      else if (selectedFolderId === 'root') params.set('folderId', 'root');
      else if (selectedFolderId) params.set('folderId', selectedFolderId);
      const r = await api<{ items: FileRow[] }>(`${baseUrl}?${params.toString()}`);
      const items = r.items ?? [];
      setFiles(uploadedById ? items.filter((f) => f.uploadedById === uploadedById) : items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }, [scope, clientId, baseUrl, selectedFolderId, uploadedById]);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    void loadFiles();
    setSelectedFileIds(new Set());
  }, [loadFiles]);

  const inboxFiles = useMemo(() => files.filter((f) => f.isInbox), [files]);

  const visible = useMemo(() => {
    let list = files;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((f) => f.fileName.toLowerCase().includes(q));
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    list = list.slice().sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return a.fileName.localeCompare(b.fileName) * dir;
        case 'sizeBytes':
          return (a.sizeBytes - b.sizeBytes) * dir;
        case 'visible':
          return (Number(a.visibleInPortal) - Number(b.visibleInPortal)) * dir;
        case 'uploadedAt':
        default:
          return a.uploadedAt.localeCompare(b.uploadedAt) * dir;
      }
    });
    return list;
  }, [files, search, sortKey, sortDir]);

  function toggleSort(key: SortKey): void {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  }

  function toggleSelect(id: string): void {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll(): void {
    if (selectedFileIds.size === visible.length) setSelectedFileIds(new Set());
    else setSelectedFileIds(new Set(visible.map((f) => f.id)));
  }

  async function handleUpload(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const targetFolder =
        typeof selectedFolderId === 'string' &&
        selectedFolderId !== 'root' &&
        selectedFolderId !== 'inbox'
          ? selectedFolderId
          : null;
      if (targetFolder) formData.append('folderId', targetFolder);
      const csrf = sessionStorage.getItem('__vibe_csrf');
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: csrf ? { 'X-CSRF-Token': csrf } : {},
        body: formData,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `upload_${res.status}`);
      }
      await loadFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload_failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleUploadLink(): Promise<void> {
    const fileName = prompt('Display name for the link');
    if (!fileName) return;
    const externalUrl = prompt('External URL (https://...)');
    if (!externalUrl) return;
    setBusy(true);
    setError(null);
    try {
      const folderId =
        typeof selectedFolderId === 'string' &&
        selectedFolderId !== 'root' &&
        selectedFolderId !== 'inbox'
          ? selectedFolderId
          : null;
      await api(`${baseUrl}/upload-link`, {
        method: 'POST',
        body: JSON.stringify({ fileName, externalUrl, folderId }),
      });
      await loadFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload_link_failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleNewFolder(): Promise<void> {
    const name = prompt('Folder name');
    if (!name || !name.trim()) return;
    const parentFolderId =
      typeof selectedFolderId === 'string' &&
      selectedFolderId !== 'root' &&
      selectedFolderId !== 'inbox'
        ? selectedFolderId
        : null;
    try {
      if (scope === 'internal') {
        await api('/api/staff/internal-files/folders', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), parentFolderId }),
        });
      } else {
        await api(folderUrl, {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), parentFolderId }),
        });
      }
      await loadFolders();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create_folder_failed');
    }
  }

  async function handleRenameFolder(id: string, name: string): Promise<void> {
    try {
      if (scope === 'internal') {
        await api(`/api/staff/internal-files/folders/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        });
      } else {
        await api(`${folderUrl}/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        });
      }
      await loadFolders();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'rename_failed');
    }
  }

  async function handleDeleteFolder(id: string): Promise<void> {
    try {
      if (scope === 'internal') {
        await api(`/api/staff/internal-files/folders/${id}`, { method: 'DELETE' });
      } else {
        await api(`${folderUrl}/${id}`, { method: 'DELETE' });
      }
      if (selectedFolderId === id) setSelectedFolderId('root');
      await loadFolders();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete_folder_failed');
    }
  }

  async function handleDropToFolder(fileId: string, folderId: string | null): Promise<void> {
    try {
      await api(`${baseUrl}/${fileId}/move`, {
        method: 'POST',
        body: JSON.stringify({ folderId }),
      });
      await loadFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'move_failed');
    }
  }

  async function handleToggleVisibility(file: FileRow): Promise<void> {
    if (scope === 'internal') return;
    try {
      await api(`${baseUrl}/${file.id}/visibility`, {
        method: 'POST',
        body: JSON.stringify({ visibleInPortal: !file.visibleInPortal }),
      });
      await loadFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'visibility_failed');
    }
  }

  async function handleBulkMove(folderId: string | null): Promise<void> {
    try {
      await api(`${baseUrl}/bulk-move`, {
        method: 'POST',
        body: JSON.stringify({ fileIds: Array.from(selectedFileIds), folderId }),
      });
      setSelectedFileIds(new Set());
      await loadFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'bulk_move_failed');
    }
  }

  async function handleBulkVisibility(visible: boolean): Promise<void> {
    if (scope === 'internal') return;
    try {
      await api(`${baseUrl}/bulk-visibility`, {
        method: 'POST',
        body: JSON.stringify({ fileIds: Array.from(selectedFileIds), visibleInPortal: visible }),
      });
      setSelectedFileIds(new Set());
      await loadFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'bulk_visibility_failed');
    }
  }

  async function handleBulkDelete(): Promise<void> {
    if (!confirm(`Delete ${selectedFileIds.size} file(s)?`)) return;
    try {
      await api(`${baseUrl}/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ fileIds: Array.from(selectedFileIds) }),
      });
      setSelectedFileIds(new Set());
      await loadFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'bulk_delete_failed');
    }
  }

  async function handleSpawnTemplate(templateId: string): Promise<void> {
    if (!clientId) return;
    try {
      const parentFolderId =
        typeof selectedFolderId === 'string' &&
        selectedFolderId !== 'root' &&
        selectedFolderId !== 'inbox'
          ? selectedFolderId
          : null;
      await api(`/api/staff/clients/${clientId}/folders/from-template`, {
        method: 'POST',
        body: JSON.stringify({ templateId, parentFolderId }),
      });
      await loadFolders();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'template_spawn_failed');
    }
  }

  function rememberRecentlyViewed(fileId: string, fileName: string): void {
    try {
      const key = '__vibe_recently_viewed_files';
      const raw = localStorage.getItem(key);
      const list: {
        id: string;
        fileName: string;
        viewedAt: string;
        scope: string;
        clientId?: string;
      }[] = raw ? JSON.parse(raw) : [];
      const next = [
        { id: fileId, fileName, viewedAt: new Date().toISOString(), scope, clientId },
        ...list.filter((r) => r.id !== fileId),
      ].slice(0, 50);
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // localStorage unavailable — fail silent
    }
  }

  const breadcrumb = (): string => {
    if (selectedFolderId === 'inbox') return 'File inbox';
    if (selectedFolderId === 'root' || selectedFolderId === null) return 'All files';
    const folder = folders.find((f) => f.id === selectedFolderId);
    if (!folder) return 'All files';
    const parts: string[] = [folder.name];
    let cur: Folder | undefined = folder;
    while (cur?.parentFolderId) {
      const parent = folders.find((f) => f.id === cur!.parentFolderId);
      if (!parent) break;
      parts.unshift(parent.name);
      cur = parent;
    }
    return parts.join(' › ');
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16 }}>
      <input
        ref={fileInput}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleUpload(f);
          if (e.target) e.target.value = '';
        }}
      />

      <aside
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          padding: 12,
          minWidth: 0,
        }}
      >
        <FolderTree
          folders={folders}
          selectedFolderId={selectedFolderId}
          onSelectFolder={setSelectedFolderId}
          inboxCount={inboxFiles.length}
          totalCount={files.length}
          onRename={handleRenameFolder}
          onDelete={handleDeleteFolder}
          onDropFile={handleDropToFolder}
          scope={scope}
        />
        {scope === 'client' && (
          <div style={{ borderTop: `1px solid ${tokens.color.border}`, paddingTop: 8 }}>
            <FileInboxSidebar files={inboxFiles} />
          </div>
        )}
      </aside>

      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          padding: 12,
          minWidth: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{breadcrumb()}</div>
          <Pill>{visible.length}</Pill>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="search"
              placeholder="Search files"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search files"
              style={{
                padding: '6px 8px',
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                fontSize: 12,
                background: tokens.color.bg,
                color: tokens.color.text,
              }}
            />
            <AddDropdown
              disabled={busy}
              onUploadFile={() => fileInput.current?.click()}
              onUploadLink={() => void handleUploadLink()}
              onNewFolder={() => void handleNewFolder()}
              onUploadFolder={() => alert('Upload folder — coming soon (single zip extraction)')}
              onFolderTemplate={() => {
                if (scope === 'client') setTemplatePickerOpen(true);
                else alert('Folder templates apply to clients only for now.');
              }}
            />
          </div>
        </div>

        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
            {error}
          </p>
        )}

        {selectedFileIds.size > 0 && (
          <BulkActionsBar
            selectedCount={selectedFileIds.size}
            onClearSelection={() => setSelectedFileIds(new Set())}
            onMove={(folderId) => void handleBulkMove(folderId)}
            onSetVisibility={(v) => void handleBulkVisibility(v)}
            onDelete={() => void handleBulkDelete()}
            onShare={() => setShareOpen(true)}
            folders={folders}
          />
        )}

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th style={thStyle()}>
                  <input
                    type="checkbox"
                    aria-label="Select all visible files"
                    checked={visible.length > 0 && selectedFileIds.size === visible.length}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate =
                          selectedFileIds.size > 0 && selectedFileIds.size < visible.length;
                      }
                    }}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th style={thStyle()}>
                  <button type="button" onClick={() => toggleSort('name')} style={sortBtnStyle()}>
                    Name {sortKey === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th style={thStyle()}>
                  <button
                    type="button"
                    onClick={() => toggleSort('uploadedAt')}
                    style={sortBtnStyle()}
                  >
                    Date added {sortKey === 'uploadedAt' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                <th style={thStyle()}>
                  <button
                    type="button"
                    onClick={() => toggleSort('sizeBytes')}
                    style={sortBtnStyle()}
                  >
                    Size {sortKey === 'sizeBytes' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </button>
                </th>
                {scope === 'client' && (
                  <th style={thStyle()}>
                    <button
                      type="button"
                      onClick={() => toggleSort('visible')}
                      style={sortBtnStyle()}
                    >
                      Visible {sortKey === 'visible' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                    </button>
                  </th>
                )}
                <th style={thStyle()} />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td
                    colSpan={scope === 'client' ? 6 : 5}
                    style={{
                      padding: 24,
                      textAlign: 'center',
                      fontSize: 13,
                      color: tokens.color.textMuted,
                    }}
                  >
                    No files in this view.
                  </td>
                </tr>
              )}
              {visible.map((f) => {
                const checked = selectedFileIds.has(f.id);
                return (
                  <tr
                    key={f.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/x-vibe-file', f.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    style={{
                      borderTop: `1px solid ${tokens.color.border}`,
                      background: checked ? tokens.color.surface : 'transparent',
                    }}
                  >
                    <td style={tdStyle()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${f.fileName}`}
                        checked={checked}
                        onChange={() => toggleSelect(f.id)}
                      />
                    </td>
                    <td style={tdStyle()}>
                      {f.externalUrl ? (
                        <a
                          href={f.externalUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          onClick={() => rememberRecentlyViewed(f.id, f.fileName)}
                          style={{ color: tokens.color.accent, textDecoration: 'none' }}
                        >
                          🔗 {f.fileName}
                        </a>
                      ) : (
                        <a
                          href={
                            scope === 'internal'
                              ? `/api/staff/internal-files/${f.id}/download`
                              : `/api/staff/clients/${clientId}/files/${f.id}/download`
                          }
                          onClick={() => rememberRecentlyViewed(f.id, f.fileName)}
                          style={{ color: tokens.color.accent, textDecoration: 'none' }}
                        >
                          📄 {f.fileName}
                        </a>
                      )}
                    </td>
                    <td style={tdStyle()}>{f.uploadedAt.slice(0, 10)}</td>
                    <td style={tdStyle()}>{humanSize(f.sizeBytes)}</td>
                    {scope === 'client' && (
                      <td style={tdStyle()}>
                        <VisibilityToggle
                          visible={f.visibleInPortal}
                          onToggle={() => void handleToggleVisibility(f)}
                          ariaLabel={`Toggle portal visibility for ${f.fileName}`}
                        />
                      </td>
                    )}
                    <td style={tdStyle()}>
                      <RowMenu
                        onMove={() => {
                          setSelectedFileIds(new Set([f.id]));
                        }}
                        onShare={() => {
                          setSelectedFileIds(new Set([f.id]));
                          setShareOpen(true);
                        }}
                        onDelete={async () => {
                          if (confirm(`Delete ${f.fileName}?`)) {
                            await api(
                              scope === 'internal'
                                ? `/api/staff/internal-files/${f.id}`
                                : `/api/staff/clients/${clientId}/files/${f.id}`,
                              { method: 'DELETE' },
                            );
                            await loadFiles();
                          }
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        clientId={clientId ?? null}
        files={files
          .filter((f) => selectedFileIds.has(f.id))
          .map((f) => ({ id: f.id, fileName: f.fileName }))}
      />

      {scope === 'client' && clientId && (
        <FolderTemplatePicker
          clientId={clientId}
          open={templatePickerOpen}
          onClose={() => setTemplatePickerOpen(false)}
          onPicked={handleSpawnTemplate}
        />
      )}
    </div>
  );
}

function thStyle(): React.CSSProperties {
  return {
    padding: '8px 6px',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: tokens.color.textMuted,
    fontWeight: 600,
  };
}

function tdStyle(): React.CSSProperties {
  return { padding: '8px 6px', verticalAlign: 'middle' };
}

function sortBtnStyle(): React.CSSProperties {
  return {
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    color: 'inherit',
    fontSize: 'inherit',
    fontWeight: 'inherit',
    textTransform: 'inherit',
    letterSpacing: 'inherit',
  } as React.CSSProperties;
}

function RowMenu({
  onMove,
  onShare,
  onDelete,
}: {
  onMove: () => void;
  onShare: () => void;
  onDelete: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Row actions"
        style={{
          background: 'none',
          border: 'none',
          padding: '2px 6px',
          cursor: 'pointer',
          color: tokens.color.textMuted,
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        ⋮
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 140,
            background: tokens.color.bg,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
            zIndex: 30,
            padding: 4,
          }}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onMove();
            }}
            style={menuItemStyle()}
          >
            Move…
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onShare();
            }}
            style={menuItemStyle()}
          >
            Share…
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void onDelete();
            }}
            style={{ ...menuItemStyle(), color: tokens.color.danger }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function menuItemStyle(): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    padding: '6px 10px',
    background: 'none',
    border: 'none',
    textAlign: 'left',
    fontSize: 13,
    cursor: 'pointer',
    color: tokens.color.text,
  };
}
