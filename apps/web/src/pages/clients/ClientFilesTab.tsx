/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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

import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';

import {
  Button,
  Card,
  ChevronDown,
  ChevronRight,
  Combobox,
  Download,
  Eye,
  Flag,
  Folder,
  Input,
  Lock,
  Pill,
  Search,
  ShareIcon,
  Table,
  tokens,
  Trash,
} from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';
import { ShareFileDialog } from './ShareFileDialog';
import { BulkShareDialog } from './BulkShareDialog';
import { UnlinkedEmptyState } from './fmv2/UnlinkedEmptyState';
import { IndexingToast } from './fmv2/IndexingToast';
import { IndexingProgressBar } from './fmv2/IndexingProgressBar';

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

interface TemplateFolder {
  name: string;
  visibility: 'private' | 'client_visible' | null;
}

interface ListResponse {
  items: FileRow[];
  unbound?: boolean;
  clientFolderId?: string;
  storagePath?: string;
  status?: 'active' | 'renaming' | 'missing' | 'conflict' | 'orphan';
  lastSyncedAt?: string | null;
  // Virtual folder skeleton resolved from the client's (or firm default)
  // folder template — shown in the Explorer even when empty.
  templateFolders?: TemplateFolder[];
}

// File subfolderPath values carry a trailing slash (e.g. "Income Tax/");
// template folder names do not. Normalize template names to the same
// trailing-slash key so a template "Income Tax" and a file in "Income Tax/"
// collapse to one folder.
function templateFolderKey(name: string): string {
  const trimmed = name.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

type VisibilityFilter = 'all' | 'private' | 'client_visible';

/** Icon-only action button with a native-tooltip label (hover popup) +
 *  accessible name. Used across the Files toolbar + per-row actions. */
function IconButton({
  label,
  onClick,
  disabled,
  tone = 'default',
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'accent' | 'success' | 'danger';
  children: React.ReactNode;
}): JSX.Element {
  const color =
    tone === 'accent'
      ? tokens.color.accent
      : tone === 'success'
        ? tokens.color.success
        : tone === 'danger'
          ? tokens.color.danger
          : tokens.color.text;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        borderRadius: tokens.radius.sm,
        border: `1px solid ${tokens.color.border}`,
        background: 'transparent',
        color: disabled ? tokens.color.textMuted : color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

// ── Folder tree model ───────────────────────────────────────────────────
// Subfolder keys are slash-delimited with a trailing slash ("Income Tax/",
// "Income Tax/2025/"). Build a nested tree so the left panel can collapse
// roots and expand into nested subfolders.
export interface FolderNode {
  /** Display segment ("2025"). */
  name: string;
  /** Full subfolderPath key for selection + exact-match file count. */
  path: string;
  /** Files whose subfolderPath === this exact path. */
  count: number;
  children: FolderNode[];
}

export function buildFolderTree(keys: string[], countOf: (key: string) => number): FolderNode[] {
  const roots: FolderNode[] = [];
  const byPath = new Map<string, FolderNode>();
  // Ensure a node (and all its ancestors) exists for a given key.
  function ensure(key: string): FolderNode {
    const existing = byPath.get(key);
    if (existing) return existing;
    const trimmed = key.replace(/\/+$/, '');
    const slash = trimmed.lastIndexOf('/');
    const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
    const node: FolderNode = { name, path: key, count: countOf(key), children: [] };
    byPath.set(key, node);
    if (slash >= 0) {
      const parentKey = `${trimmed.slice(0, slash)}/`;
      ensure(parentKey).children.push(node);
    } else {
      roots.push(node);
    }
    return node;
  }
  for (const key of keys) {
    if (key === '') continue; // folder-root files handled separately
    ensure(key);
  }
  const sortRec = (nodes: FolderNode[]): void => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** True when the drag payload contains OS files (vs text/element drags). */
function dragHasFiles(e: DragEvent<HTMLElement>): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

/** One selectable row in the folder panel (also used for "All" + root). */
function FolderRow({
  label,
  count,
  depth,
  selected,
  onSelect,
  mono,
  chevron,
  onDropFiles,
  onDragHover,
}: {
  label: string;
  count: number;
  depth: number;
  selected: boolean;
  onSelect: () => void;
  mono?: boolean;
  chevron?: React.ReactNode;
  /** When set, the row accepts file drops (drag-and-drop upload). */
  onDropFiles?: (files: File[]) => void;
  /** Reports drag-hover so the parent can label the active drop target. */
  onDragHover?: (over: boolean) => void;
}): JSX.Element {
  const [dragOver, setDragOver] = useState(false);
  const setOver = (over: boolean): void => {
    setDragOver(over);
    onDragHover?.(over);
  };
  return (
    <div
      style={{ display: 'flex', alignItems: 'center' }}
      onDragEnter={(e) => {
        if (!onDropFiles || !dragHasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!onDropFiles || !dragHasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!onDropFiles || !dragHasFiles(e)) return;
        // Transitions between the row's own children fire enter/leave
        // pairs — only clear when the pointer actually left the row.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(e) => {
        if (!onDropFiles || !dragHasFiles(e)) return;
        e.preventDefault();
        // Don't let the tab-wide drop handler also file these.
        e.stopPropagation();
        setOver(false);
        onDropFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div style={{ width: depth * 14, flexShrink: 0 }} />
      {chevron ?? (depth > 0 ? <span style={{ width: 18, flexShrink: 0 }} /> : null)}
      <button
        type="button"
        onClick={onSelect}
        style={{
          flex: 1,
          textAlign: 'left',
          padding: '6px 10px',
          borderRadius: tokens.radius.sm,
          background: dragOver
            ? tokens.color.accentMuted
            : selected
              ? tokens.color.accentMuted
              : 'transparent',
          color: selected || dragOver ? tokens.color.accent : tokens.color.text,
          border: 'none',
          outline: dragOver ? `2px dashed ${tokens.color.accent}` : undefined,
          outlineOffset: -2,
          cursor: 'pointer',
          fontSize: 13,
          fontFamily: mono ? tokens.font.mono : tokens.font.body,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label} <span style={{ color: tokens.color.textMuted }}>({count})</span>
      </button>
    </div>
  );
}

/** Breadcrumb of the selected folder path + drill-in chips for its
 *  immediate subfolders (the right-card half of the navigation). */
function FolderBreadcrumb({
  selectedPath,
  onSelect,
  childChips,
}: {
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  childChips: FolderNode[];
}): JSX.Element | null {
  // Build crumb segments from the trailing-slash path key.
  const crumbs: { label: string; path: string | null }[] = [{ label: 'All', path: null }];
  if (selectedPath && selectedPath !== '') {
    const segs = selectedPath.replace(/\/+$/, '').split('/');
    let acc = '';
    for (const s of segs) {
      acc += `${s}/`;
      crumbs.push({ label: s, path: acc });
    }
  } else if (selectedPath === '') {
    crumbs.push({ label: '(folder root)', path: '' });
  }
  const showChips = childChips.length > 0;
  if (crumbs.length === 1 && !showChips) return null;
  return (
    <div style={{ marginBottom: 10, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span
              key={c.path ?? '__all__'}
              style={{ display: 'inline-flex', alignItems: 'center' }}
            >
              {i > 0 && (
                <span style={{ color: tokens.color.textMuted, margin: '0 2px' }}>
                  <ChevronRight size={12} />
                </span>
              )}
              <button
                type="button"
                onClick={() => onSelect(c.path)}
                disabled={last}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: '2px 4px',
                  fontSize: 13,
                  cursor: last ? 'default' : 'pointer',
                  color: last ? tokens.color.text : tokens.color.accent,
                  fontWeight: last ? 600 : 400,
                  fontFamily: c.path ? tokens.font.mono : tokens.font.body,
                }}
              >
                {c.label}
              </button>
            </span>
          );
        })}
      </div>
      {showChips && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {childChips.map((node) => (
            <button
              key={node.path}
              type="button"
              onClick={() => onSelect(node.path)}
              title={`Open ${node.name}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: tokens.radius.pill,
                border: `1px solid ${tokens.color.border}`,
                background: tokens.color.surface,
                color: tokens.color.text,
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: tokens.font.mono,
              }}
            >
              <Folder size={13} color={tokens.color.textMuted} />
              {node.name}
              <span style={{ color: tokens.color.textMuted }}>({node.count})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Recursive folder-tree node: a row plus its children when expanded. */
function FolderTreeNode({
  node,
  depth,
  selectedPath,
  expanded,
  onSelect,
  onToggle,
  onDropFiles,
  onDragHover,
}: {
  node: FolderNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  /** When set, every row in the subtree accepts file drops into its path. */
  onDropFiles?: (path: string, files: File[]) => void;
  onDragHover?: (path: string, over: boolean) => void;
}): JSX.Element {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.path);
  const chevron = hasChildren ? (
    <button
      type="button"
      aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
      onClick={() => onToggle(node.path)}
      style={{
        width: 18,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: 'none',
        color: tokens.color.textMuted,
        cursor: 'pointer',
        padding: 0,
      }}
    >
      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  ) : (
    <span style={{ width: 18, flexShrink: 0 }} />
  );
  return (
    <>
      <FolderRow
        label={node.name}
        count={node.count}
        depth={depth}
        mono
        selected={selectedPath === node.path}
        onSelect={() => onSelect(node.path)}
        chevron={chevron}
        onDropFiles={onDropFiles ? (files) => onDropFiles(node.path, files) : undefined}
        onDragHover={onDragHover ? (over) => onDragHover(node.path, over) : undefined}
      />
      {isOpen &&
        node.children.map((child) => (
          <FolderTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            expanded={expanded}
            onSelect={onSelect}
            onToggle={onToggle}
            onDropFiles={onDropFiles}
            onDragHover={onDragHover}
          />
        ))}
    </>
  );
}

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

/** PDFs get an in-browser Preview action. Trust the filename extension
 *  too — explorer-discovered files can carry a generic octet-stream
 *  mime even when they're really PDFs. */
function isPdfFile(f: { mimeType: string | null; originalFilename: string }): boolean {
  return (
    (f.mimeType ?? '').toLowerCase().includes('pdf') ||
    f.originalFilename.toLowerCase().endsWith('.pdf')
  );
}

export function ClientFilesTab({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName?: string;
}): JSX.Element {
  const canView = usePermission('storage:folder:view');
  const canEdit = usePermission('storage:folder:edit');
  const canBind = usePermission('storage:folder:bind');
  const canReconcile = usePermission('storage:folder:reconcile');
  const canRename = usePermission('storage:folder:rename');
  const canPublish = usePermission('storage:file:publish');
  const canUnpublish = usePermission('storage:file:unpublish');
  const canDelete = usePermission('storage:file:delete');

  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Folder-template assignment (optional header control, gated on edit).
  const [templates, setTemplates] = useState<{ id: string; name: string; isDefault: boolean }[]>(
    [],
  );
  const [assignedTemplateId, setAssignedTemplateId] = useState<string>('');

  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedSubfolder, setSelectedSubfolder] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Expanded folder-tree nodes (by full path key) in the left panel.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const [uploadOpen, setUploadOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);

  // Drag-and-drop upload. dragDepth counts nested dragenter/dragleave
  // pairs (children fire their own) — the overlay shows while > 0.
  const [dragDepth, setDragDepth] = useState(0);
  const [dropStatus, setDropStatus] = useState<{ done: number; total: number } | null>(null);
  // Folder row currently hovered as a drop target (null path = "All",
  // '' = folder root); null when no specific row is hovered.
  const [dropHover, setDropHover] = useState<{ path: string | null } | null>(null);

  // FMv2 Phase C — post-link indexing transition. justLinkedPath is
  // the storage_path returned from /folder/link or /folder/create;
  // when set, we render the IndexingToast + IndexingProgressBar in
  // place of the normal Storage folder card. Cleared on
  // indexing-completed event, which also triggers load() to pull
  // the freshly-indexed file list.
  const [justLinkedPath, setJustLinkedPath] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  // Tax-return intake — the file the partner is flagging. When non-null,
  // the modal is open. Submit POSTs /api/staff/tax/returns/intake-from-file.
  const [flagFor, setFlagFor] = useState<FileRow | null>(null);
  const [shareFor, setShareFor] = useState<FileRow | null>(null);
  // In-app PDF preview. Holds the file + a short-lived inline presigned
  // URL the modal renders in an <iframe> (no download).
  const [previewFor, setPreviewFor] = useState<{ file: FileRow; url: string } | null>(null);

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

  // Load the firm's folder templates for the assignment selector. The files
  // response exposes the resolved skeleton but not the assigned template id,
  // so the selector is an assign control (no preselected value) rather than a
  // bound state mirror.
  useEffect(() => {
    if (!canEdit) return;
    void api<{ templates: { id: string; name: string; isDefault: boolean }[] }>(
      '/api/staff/admin/folder-templates',
    )
      .then((r) => setTemplates(r.templates ?? []))
      .catch(() => setTemplates([]));
  }, [canEdit]);

  async function assignTemplate(value: string): Promise<void> {
    setAssignedTemplateId(value);
    setBusy(true);
    try {
      await api(`/api/staff/admin/folder-templates/assign/${clientId}`, {
        method: 'PUT',
        body: JSON.stringify({ templateId: value === '' ? null : value }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'assign_template_failed');
    } finally {
      setBusy(false);
    }
  }

  const subfolders = useMemo(() => {
    if (!data?.items) return [] as string[];
    // Union file-derived subfolders with the template skeleton so empty
    // template folders still appear. Template names are normalized to the
    // same trailing-slash key format as file subfolderPaths before de-duping.
    const keys = new Set(data.items.map((f) => f.subfolderPath));
    for (const tf of data.templateFolders ?? []) {
      keys.add(templateFolderKey(tf.name));
    }
    return Array.from(keys).sort();
  }, [data]);

  // Exact-match file count per subfolder key (for tree node badges).
  const folderCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of data?.items ?? []) m.set(f.subfolderPath, (m.get(f.subfolderPath) ?? 0) + 1);
    return m;
  }, [data]);

  const folderTree = useMemo(
    () => buildFolderTree(subfolders, (k) => folderCounts.get(k) ?? 0),
    [subfolders, folderCounts],
  );
  const rootFileCount = folderCounts.get('') ?? 0;

  // Immediate child subfolders of the selected node — surfaced as
  // drill-in chips in the right card so you can descend from either side.
  const childChips = useMemo(() => {
    if (selectedSubfolder === null) return folderTree; // "All" → top-level folders
    const trimmed = selectedSubfolder.replace(/\/+$/, '');
    const find = (nodes: FolderNode[]): FolderNode | null => {
      for (const n of nodes) {
        if (n.path === selectedSubfolder) return n;
        const deeper = find(n.children);
        if (deeper) return deeper;
      }
      return null;
    };
    void trimmed;
    return find(folderTree)?.children ?? [];
  }, [selectedSubfolder, folderTree]);

  function toggleFolderExpand(path: string): void {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  // Selecting a folder also expands it so its children are visible.
  function selectFolder(path: string | null): void {
    setSelectedSubfolder(path);
    if (path !== null) setExpandedFolders((prev) => new Set(prev).add(path));
  }

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

  async function deleteFile(file: FileRow): Promise<void> {
    if (
      !window.confirm(
        `Delete "${file.originalFilename}"? The file is removed from storage permanently.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api(`/api/staff/files/${file.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete_failed');
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

  async function preview(file: FileRow): Promise<void> {
    try {
      // inline=1 → the body renders in the browser instead of downloading.
      const r = await api<{ url: string }>(`/api/staff/files/${file.id}/download-url?inline=1`);
      if (r.url.startsWith('http://') || r.url.startsWith('https://')) {
        setPreviewFor({ file, url: r.url });
        return;
      }
      setError('Preview needs B2 storage (mock URLs are not browser-fetchable).');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'preview_failed');
    }
  }

  function toggleSelect(id: string): void {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  // Select-all toggle, scoped to the currently-filtered rows. When every
  // visible row is already selected, the header checkbox clears them;
  // otherwise it selects all visible (preserving any selection of rows
  // hidden by the active filter).
  const visibleIds = useMemo(() => filtered.map((f) => f.id), [filtered]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));

  // Selected files that can actually be shared (exclude pending uploads).
  const selectedShareableIds = useMemo(
    () =>
      (data?.items ?? []).filter((f) => selectedIds.has(f.id) && !f.pendingUpload).map((f) => f.id),
    [data, selectedIds],
  );
  const [bulkShareOpen, setBulkShareOpen] = useState(false);

  function toggleSelectAll(): void {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...visibleIds]);
    });
  }

  const canDropUpload = canEdit && data?.status === 'active' && !dropStatus;

  async function handleDroppedFiles(dropped: File[], target: string | null): Promise<void> {
    if (dropped.length === 0) return;
    setError(null);
    setDropStatus({ done: 0, total: dropped.length });
    const failures: string[] = [];
    for (const file of dropped) {
      try {
        // null target → the server routes by category default.
        await uploadOneClientFile(clientId, file, 'other', target ?? undefined);
      } catch {
        failures.push(file.name);
      }
      setDropStatus((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
    }
    setDropStatus(null);
    if (failures.length > 0) {
      setError(`Upload failed for: ${failures.join(', ')}`);
    }
    await load();
  }

  // Drop landed on a specific folder row (bypasses the tab-wide handler).
  function dropIntoFolder(path: string | null, files: File[]): void {
    setDragDepth(0);
    setDropHover(null);
    void handleDroppedFiles(files, path);
  }

  // Row hover reporting. Enter on the next row fires BEFORE leave on the
  // previous one, so only clear when the leaving row is still the active
  // target — otherwise the fresh value would be wiped.
  function setFolderHover(path: string | null, over: boolean): void {
    setDropHover((prev) => {
      if (over) return { path };
      return prev && prev.path === path ? null : prev;
    });
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
      <UnlinkedEmptyState
        clientId={clientId}
        clientName={clientName ?? 'this client'}
        canBind={canBind}
        canEdit={canEdit}
        canReconcile={canReconcile}
        onLinked={(_id, path) => {
          setJustLinkedPath(path);
          setIndexing(true);
          void load();
        }}
      />
    );
  }

  const statusTone =
    data.status === 'active' ? 'success' : data.status === 'renaming' ? 'warning' : 'danger';

  return (
    <div
      style={{ display: 'grid', gap: tokens.space.lg, position: 'relative' }}
      onDragEnter={(e) => {
        if (!canDropUpload || !dragHasFiles(e)) return;
        e.preventDefault();
        setDragDepth((d) => d + 1);
      }}
      onDragOver={(e) => {
        if (!canDropUpload || !dragHasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!canDropUpload || !dragHasFiles(e)) return;
        e.preventDefault();
        setDragDepth((d) => Math.max(0, d - 1));
      }}
      onDrop={(e) => {
        if (!canDropUpload || !dragHasFiles(e)) return;
        e.preventDefault();
        setDragDepth(0);
        setDropHover(null);
        void handleDroppedFiles(Array.from(e.dataTransfer.files), selectedSubfolder);
      }}
    >
      {dragDepth > 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 8,
            border: `2px dashed ${tokens.color.accent}`,
            // Light dim so folder rows stay readable as drop targets.
            background: 'rgba(0, 0, 0, 0.12)',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: 8,
              padding: '12px 20px',
              fontSize: 14,
              fontWeight: 600,
              textAlign: 'center',
            }}
          >
            {dropHover
              ? dropHover.path === null
                ? 'Drop to file by category'
                : dropHover.path === ''
                  ? 'Drop to upload into the folder root'
                  : `Drop to upload into ${dropHover.path.replace(/\/+$/, '')}`
              : `Drop to upload${
                  selectedSubfolder ? ` into ${selectedSubfolder.replace(/\/+$/, '')}` : ''
                }`}
            <div style={{ fontSize: 12, fontWeight: 400, color: tokens.color.textMuted }}>
              …or drop onto a folder in the tree to file it there
            </div>
          </div>
        </div>
      )}
      {dropStatus && (
        <Card>
          <p style={{ fontSize: 13, margin: 0 }}>
            Uploading {Math.min(dropStatus.done + 1, dropStatus.total)} of {dropStatus.total}…
          </p>
        </Card>
      )}
      {error && (
        <Card>
          <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>
        </Card>
      )}

      {justLinkedPath && (
        <IndexingToast storagePath={justLinkedPath} onDismiss={() => setJustLinkedPath(null)} />
      )}

      {indexing && (
        <Card title="Indexing in progress">
          <IndexingProgressBar
            clientId={clientId}
            onCompleted={() => {
              setIndexing(false);
              void load();
            }}
          />
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {canEdit && templates.length > 0 && (
              <div style={{ width: 200 }} title="Assign a folder-structure template to this client">
                <Combobox
                  ariaLabel="Folder template"
                  value={assignedTemplateId}
                  onChange={(v) => void assignTemplate(v)}
                  disabled={busy}
                  placeholder="Template: firm default"
                  options={[
                    { value: '', label: 'Template: firm default' },
                    ...templates.map((t) => ({
                      value: t.id,
                      label: `Template: ${t.name}${t.isDefault ? ' (default)' : ''}`,
                    })),
                  ]}
                />
              </div>
            )}
            <Button onClick={() => void load()} disabled={busy}>
              Refresh
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !canRename || data.status !== 'active' || indexing}
              title={
                indexing
                  ? 'Available after indexing completes.'
                  : !canRename
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
            <FolderRow
              label="All"
              count={data.items.length}
              depth={0}
              selected={selectedSubfolder === null}
              onSelect={() => selectFolder(null)}
              onDropFiles={canDropUpload ? (files) => dropIntoFolder(null, files) : undefined}
              onDragHover={canDropUpload ? (over) => setFolderHover(null, over) : undefined}
            />
            {rootFileCount > 0 && (
              <FolderRow
                label="(folder root)"
                count={rootFileCount}
                depth={0}
                mono
                selected={selectedSubfolder === ''}
                onSelect={() => selectFolder('')}
                onDropFiles={canDropUpload ? (files) => dropIntoFolder('', files) : undefined}
                onDragHover={canDropUpload ? (over) => setFolderHover('', over) : undefined}
              />
            )}
            {folderTree.map((node) => (
              <FolderTreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedSubfolder}
                expanded={expandedFolders}
                onSelect={selectFolder}
                onToggle={toggleFolderExpand}
                onDropFiles={canDropUpload ? dropIntoFolder : undefined}
                onDragHover={canDropUpload ? setFolderHover : undefined}
              />
            ))}
          </div>
        </Card>

        <Card>
          {/* Breadcrumb + drill-in chips (the right-card half of "both"). */}
          <FolderBreadcrumb
            selectedPath={selectedSubfolder}
            onSelect={selectFolder}
            childChips={childChips}
          />
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
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  {selectedIds.size} selected
                </span>
                <IconButton
                  label="Make client-visible (publish)"
                  tone="success"
                  disabled={busy || !canPublish}
                  onClick={() => void bulkSetVisibility('client_visible')}
                >
                  <Eye size={16} />
                </IconButton>
                <IconButton
                  label="Make private"
                  disabled={busy || !canUnpublish}
                  onClick={() => void bulkSetVisibility('private')}
                >
                  <Lock size={16} />
                </IconButton>
                <IconButton
                  label="Share selected files"
                  tone="accent"
                  disabled={busy || !canPublish || selectedShareableIds.length === 0}
                  onClick={() => setBulkShareOpen(true)}
                >
                  <ShareIcon size={16} />
                </IconButton>
              </div>
            )}
          </div>

          <Table<FileRow>
            rows={filtered}
            rowKey={(r) => r.id}
            empty="No files match the current filter."
            columns={[
              {
                key: 'select',
                header: (
                  <input
                    type="checkbox"
                    aria-label="Select all files"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected;
                    }}
                    disabled={visibleIds.length === 0}
                    onChange={toggleSelectAll}
                  />
                ),
                render: (r) => (
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.originalFilename}`}
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
                render: (r) => {
                  const visible = r.visibility === 'client_visible';
                  return (
                    <IconButton
                      label={
                        visible
                          ? 'Client-visible — click to make private'
                          : 'Private — click to make client-visible'
                      }
                      tone={visible ? 'success' : 'default'}
                      onClick={() => void toggleVisibility(r)}
                    >
                      {visible ? <Eye size={16} /> : <Lock size={16} />}
                    </IconButton>
                  );
                },
              },
              {
                key: 'actions',
                header: '',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {canPublish && (
                      <IconButton
                        label="Share securely with an outside recipient (expiring link)"
                        tone="accent"
                        onClick={() => setShareFor(r)}
                        disabled={r.pendingUpload}
                      >
                        <ShareIcon size={16} />
                      </IconButton>
                    )}
                    <IconButton
                      label="Flag as tax return — creates a draft return that can be released"
                      onClick={() => setFlagFor(r)}
                      disabled={r.pendingUpload}
                    >
                      <Flag size={16} />
                    </IconButton>
                    {isPdfFile(r) && (
                      <IconButton
                        label="Preview this PDF in the browser"
                        onClick={() => void preview(r)}
                        disabled={r.pendingUpload}
                      >
                        <Search size={16} />
                      </IconButton>
                    )}
                    <IconButton
                      label="Download"
                      tone="accent"
                      onClick={() => void download(r)}
                      disabled={r.pendingUpload}
                    >
                      <Download size={16} />
                    </IconButton>
                    {canDelete && (
                      <IconButton
                        label="Delete this file (removed from storage permanently)"
                        tone="danger"
                        onClick={() => void deleteFile(r)}
                        disabled={busy}
                      >
                        <Trash size={16} />
                      </IconButton>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      </div>

      {flagFor && (
        <FlagAsTaxReturnDialog
          file={flagFor}
          onClose={() => setFlagFor(null)}
          onCreated={() => {
            setFlagFor(null);
            void load();
          }}
        />
      )}

      {shareFor && (
        <ShareFileDialog
          file={shareFor}
          onClose={() => setShareFor(null)}
          onShared={() => setShareFor(null)}
        />
      )}

      {bulkShareOpen && (
        <BulkShareDialog
          fileIds={selectedShareableIds}
          onClose={() => setBulkShareOpen(false)}
          onShared={() => {
            setBulkShareOpen(false);
            setSelectedIds(new Set());
          }}
        />
      )}

      {previewFor && (
        <PreviewDialog
          filename={previewFor.file.originalFilename}
          url={previewFor.url}
          onClose={() => setPreviewFor(null)}
          onDownload={() => void download(previewFor.file)}
        />
      )}

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
// PDF preview dialog — renders the inline presigned URL in an <iframe>
// (browser's native PDF viewer) so staff can read a file without
// downloading it. The presigned URL is short-lived; closing the modal
// drops it.
// ---------------------------------------------------------------------------

interface PreviewDialogProps {
  filename: string;
  url: string;
  onClose: () => void;
  onDownload: () => void;
}

function PreviewDialog({ filename, url, onClose, onDownload }: PreviewDialogProps): JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${filename}`}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        flexDirection: 'column',
        padding: 24,
        zIndex: 300,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          background: tokens.color.surface,
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        >
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 13,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {filename}
          </span>
          <Button size="sm" variant="ghost" onClick={() => window.open(url, '_blank', 'noopener')}>
            Open in new tab
          </Button>
          <Button size="sm" variant="ghost" onClick={onDownload}>
            Download
          </Button>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <iframe
          title={`Preview of ${filename}`}
          src={url}
          style={{ flex: 1, width: '100%', border: 'none', minHeight: 0 }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload plumbing — reserve → PUT body → complete. Shared by the upload
// dialog and the drag-and-drop path.
// ---------------------------------------------------------------------------

async function uploadOneClientFile(
  clientId: string,
  file: File,
  category: string,
  subfolderPath?: string,
): Promise<void> {
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
      subfolderPath: subfolderPath || undefined,
      originalFilename: file.name,
      sizeBytes: file.size,
      mimeType: file.type || undefined,
    }),
  });

  // 2) Upload the body. mock-presign:// URLs route through the dev-only
  //    translator so the browser doesn't try to fetch an unsupported scheme.
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
  await api(`/api/staff/files/${reserve.fileId}/complete`, {
    method: 'POST',
    body: '{}',
  });
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
  const [phase, setPhase] = useState<'idle' | 'uploading'>('idle');

  async function go(): Promise<void> {
    if (!file) {
      setError('Pick a file first.');
      return;
    }
    setError(null);
    setPhase('uploading');
    try {
      await uploadOneClientFile(clientId, file, category, subfolderOverride);
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
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>Uploading…</p>
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

// ---------------------------------------------------------------------
// FlagAsTaxReturnDialog — minimal partner-facing intake form. Posts to
// /api/staff/tax/returns/intake-from-file which validates firm scope,
// inserts a DRAFT tax_returns row pointing at the file, and seeds one
// catch-all section (the partner can split into per-recipient sections
// later from /tax/returns/:id). Non-PDF files are allowed but the
// release/extraction pipeline assumes a paged source.
// ---------------------------------------------------------------------

const FORM_CODE_OPTIONS = [
  '1040',
  '1040-X',
  '1120',
  '1120-S',
  '1065',
  '1041',
  '990',
  '709',
  '706',
  '5500',
  'other',
] as const;

function FlagAsTaxReturnDialog({
  file,
  onClose,
  onCreated,
}: {
  file: FileRow;
  onClose: () => void;
  onCreated: (taxReturnId: string) => void;
}): JSX.Element {
  const currentYear = new Date().getFullYear();
  // Default to the prior calendar year — most flagging happens during
  // the following tax season.
  const [taxYear, setTaxYear] = useState<string>(String(currentYear - 1));
  const [formCode, setFormCode] = useState<(typeof FORM_CODE_OPTIONS)[number]>('1040');
  const [customForm, setCustomForm] = useState('');
  const [jurisdiction, setJurisdiction] = useState('federal');
  const [title, setTitle] = useState('');
  const [totalPagesInput, setTotalPagesInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const yearN = Number(taxYear);
    if (!Number.isInteger(yearN) || yearN < 1900 || yearN > 2999) {
      setError('Enter a valid tax year (1900–2999).');
      return;
    }
    const code = formCode === 'other' ? customForm.trim() : formCode;
    if (!code) {
      setError('Form code is required.');
      return;
    }
    const pages = totalPagesInput.trim() ? Number(totalPagesInput.trim()) : null;
    if (pages !== null && (!Number.isInteger(pages) || pages < 1)) {
      setError('Total pages must be a positive integer (or leave blank).');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        fileId: file.id,
        taxYear: yearN,
        formCode: code,
        jurisdiction: jurisdiction.trim() || 'federal',
      };
      if (title.trim()) body['title'] = title.trim();
      if (pages !== null) body['totalPages'] = pages;
      const r = await api<{ taxReturnId: string }>('/api/staff/tax/returns/intake-from-file', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onCreated(r.taxReturnId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'create_failed';
      setError(
        msg === 'file_already_flagged'
          ? 'This file is already flagged as a tax return. Open the existing return from the Tax page.'
          : msg === 'file_pending_upload'
            ? 'Upload is still in progress — try again in a moment.'
            : `Flag failed: ${msg}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const isPdf = (file.mimeType ?? '').toLowerCase().includes('pdf');

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
        paddingTop: 56,
        zIndex: 200,
      }}
    >
      <form onSubmit={(e) => void submit(e)} style={{ minWidth: 520, maxWidth: 640 }}>
        <Card title="Flag file as tax return">
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
            Source file:{' '}
            <span style={{ fontFamily: tokens.font.mono }}>{file.originalFilename}</span>
            {!isPdf && (
              <span style={{ color: tokens.color.warning, marginLeft: 6 }}>
                · not a PDF — release scoping assumes a paged document
              </span>
            )}
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Tax year</label>
                <input
                  type="number"
                  min={1900}
                  max={2999}
                  value={taxYear}
                  onChange={(e) => setTaxYear(e.target.value)}
                  style={dlgInput()}
                />
              </div>
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Form code</label>
                <select
                  value={formCode}
                  onChange={(e) =>
                    setFormCode(e.target.value as (typeof FORM_CODE_OPTIONS)[number])
                  }
                  style={dlgInput()}
                >
                  {FORM_CODE_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Jurisdiction</label>
                <input
                  type="text"
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                  placeholder="federal, CA, NY…"
                  style={dlgInput()}
                />
              </div>
            </div>
            {formCode === 'other' && (
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  Custom form code
                </label>
                <input
                  type="text"
                  value={customForm}
                  onChange={(e) => setCustomForm(e.target.value)}
                  placeholder="e.g. 1099-NEC"
                  style={dlgInput()}
                />
              </div>
            )}
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
                Title (optional — defaults to &ldquo;{formCode} · {taxYear} ·{' '}
                {file.originalFilename}&rdquo;)
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={dlgInput()}
              />
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
                Total pages (optional — needed for full-document release scoping)
              </label>
              <input
                type="number"
                min={1}
                value={totalPagesInput}
                onChange={(e) => setTotalPagesInput(e.target.value)}
                placeholder="Leave blank to set later"
                style={dlgInput()}
              />
            </div>
            {error && (
              <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
                {error}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Flagging…' : 'Flag as tax return'}
              </Button>
            </div>
          </div>
        </Card>
      </form>
    </div>
  );
}

function dlgInput(): React.CSSProperties {
  return {
    padding: '8px 10px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.surface,
    color: tokens.color.text,
  };
}
