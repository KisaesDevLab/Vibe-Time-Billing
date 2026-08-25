/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Vibe Filer — staff document inbox / routing module. Three tabs:
//
//   - Inbox    — the scan results: every object found in the drop bucket,
//                parsed + matched against the active rule profile, with
//                per-row review actions (file / flag for tax / skip),
//                manual client assignment, year + folder overrides, and a
//                bulk Commit that relocates the files in B2 (undoable).
//                A drag-and-drop zone uploads documents straight into the
//                Inbox/ prefix and re-scans.
//   - Rules    — rule profiles + ordered match rules that drive the parse
//                + routing engine.
//   - History  — committed routing batches, with per-batch and per-file
//                undo.
//   - Import   — 0153: upload a client document export (.zip), confirm
//                the auto-matched client (External/AWS Id in the zip
//                name), pick a destination folder, and the worker
//                extracts it preserving the zip's structure — never
//                overwriting (same-name files are skipped + reported),
//                always internal-only.
//
// Mounted at /filer. Matches the dark-theme inline-style conventions of
// the other staff table pages (TaxReturnsTab / Engagements): @vibe/ui
// primitives + the shared useColumnView / selectRows + TableSearch on the
// inbox table. No Tailwind on this page.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Button,
  Card,
  ColumnFilter,
  Combobox,
  EmptyState,
  PaginationBar,
  Pill,
  ScrollX,
  Tabs,
  tokens,
} from '@vibe/ui';

import { api, getCsrfToken } from '../api-client';
import { TableSearch } from '../components/TableSearch';
import { selectRows, useColumnView } from '../lib/column-view';
import { useClientPage } from '../lib/use-paged-list';

// ── API contract types ──────────────────────────────────────────────────

type MatchStatus =
  | 'matched'
  | 'fuzzy'
  | 'inactive'
  | 'name_mismatch'
  | 'year_needed'
  | 'folder_unbound'
  | 'unparseable';

type ReviewAction = 'file' | 'flag_tax' | 'skip' | 'file_flag_tax' | null;

interface InboxRow {
  id: string;
  objectKey: string;
  originalName: string;
  sizeBytes: number;
  parsedName: string | null;
  parsedId: string | null;
  parsedYear: number | null;
  matchStatus: MatchStatus;
  matchedClient: string | null;
  clientName: string | null;
  clientExternalId: string | null;
  clientAwsId: string | null;
  suggestedRule: string | null;
  suggestedPath: string | null;
  reviewAction: ReviewAction;
  overrideFolder: string | null;
  overrideYear: number | null;
  flagFormCode: string | null;
  flagTaxYear: number | null;
  included: boolean;
  k1RecipientName: string | null;
  k1MatchedClient: string | null;
  k1ClientName: string | null;
  k1ClientExternalId: string | null;
  k1MatchScore: number | null;
  k1Status: 'suggested' | 'confirmed' | 'dismissed' | null;
  k1OverrideFolder: string | null;
}

type MatchMode = 'contains' | 'starts_with' | 'regex';
type YearBehavior = 'none' | 'current_only' | 'current_and_next' | 'previous';

interface Rule {
  id: string;
  profileId: string;
  sortOrder: number;
  name: string;
  identifier: string;
  matchMode: MatchMode;
  caseSensitive: boolean;
  targetPath: string;
  yearBehavior: YearBehavior;
  isTaxReturn: boolean;
  enabled: boolean;
  notes: string | null;
}

interface Profile {
  id: string;
  name: string;
  isActive: boolean;
  k1TargetPath: string;
  k1YearBehavior: YearBehavior;
  createdAt: string;
}

interface BatchRow {
  batchId: string;
  at: string;
  total: number;
  filed: number;
  k1: number;
  reversed: number;
}

type LogAction = 'filed' | 'tax_flagged' | 'skipped' | 'failed' | 'k1_recipient';
type LogStatus = 'success' | 'reversed' | 'error';

interface LogRow {
  id: string;
  objectKeyFrom: string;
  objectKeyTo: string | null;
  action: LogAction;
  status: LogStatus;
  folderPath: string | null;
  clientId: string | null;
  taxReturnId: string | null;
  error: string | null;
  createdAt: string;
}

interface ClientPick {
  id: string;
  name: string;
  externalId: string | null;
}

// ── Shared styling helpers ───────────────────────────────────────────────

const BASE = '/api/staff/filer';

/** Token-styled raw <input>/<select> base — box-sizing + surface + border. */
const controlStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  padding: '6px 8px',
  fontSize: 13,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  background: tokens.color.bg,
  color: tokens.color.text,
  fontFamily: tokens.font.body,
};

function th(align: 'left' | 'right' | 'center' = 'left'): React.CSSProperties {
  return {
    textAlign: align,
    padding: '10px 8px',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: tokens.color.textMuted,
    fontWeight: 600,
    borderBottom: `1px solid ${tokens.color.border}`,
    whiteSpace: 'nowrap',
  };
}

function td(): React.CSSProperties {
  return { padding: '8px', fontSize: 13, verticalAlign: 'middle' };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_LABELS: Record<MatchStatus, string> = {
  matched: 'Matched',
  fuzzy: 'Fuzzy',
  inactive: 'Inactive',
  name_mismatch: 'Name mismatch',
  year_needed: 'Year needed',
  folder_unbound: 'Folder unbound',
  unparseable: 'Unparseable',
};

function statusTone(s: MatchStatus): 'success' | 'warning' | 'danger' {
  if (s === 'matched') return 'success';
  if (s === 'unparseable') return 'danger';
  return 'warning';
}

// A row can never be committed when it has no resolvable destination.
function isCommittable(r: InboxRow): boolean {
  return r.matchStatus !== 'unparseable' && r.matchStatus !== 'folder_unbound';
}

// ── Top-level page ───────────────────────────────────────────────────────

type Tab = 'inbox' | 'rules' | 'history' | 'import';

export function FilerPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('inbox');

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1400 }}>
      <Tabs
        tabs={[
          { key: 'inbox', label: 'Inbox' },
          { key: 'import', label: 'Import' },
          { key: 'rules', label: 'Rules' },
          { key: 'history', label: 'History' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as Tab)}
      />
      {tab === 'inbox' && <InboxTab />}
      {tab === 'import' && <ImportTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'history' && <HistoryTab />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Inbox tab
// ═══════════════════════════════════════════════════════════════════════

function InboxTab(): JSX.Element {
  const [items, setItems] = useState<InboxRow[]>([]);
  const [clients, setClients] = useState<ClientPick[]>([]);
  const [activeProfile, setActiveProfile] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<{ scanned: number; matched: number } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const view = useColumnView('vibe.filer.view', { sortCol: 'status', sortDir: 'asc' });

  const loadInbox = useCallback(async (): Promise<void> => {
    const r = await api<{ items: InboxRow[] }>(`${BASE}/inbox`);
    setItems(r.items ?? []);
  }, []);

  const loadProfiles = useCallback(async (): Promise<void> => {
    const r = await api<{ items: Profile[] }>(`${BASE}/profiles`);
    setActiveProfile(r.items.find((p) => p.isActive)?.name ?? null);
  }, []);

  const loadClients = useCallback(async (): Promise<void> => {
    // The picker endpoint may return `{rows}` or `{items}` — handle both.
    const r = await api<{ rows?: ClientPick[]; items?: ClientPick[] }>('/api/staff/clients/picker');
    setClients(r.rows ?? r.items ?? []);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([loadInbox(), loadProfiles(), loadClients()]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load inbox');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadInbox, loadProfiles, loadClients]);

  async function refresh(): Promise<void> {
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ scanned: number; matched: number }>(`${BASE}/scan`, { method: 'POST' });
      setScanResult(r);
      await Promise.all([loadInbox(), loadProfiles()]);
      // Drop selections that no longer exist after a re-scan.
      setSelectedIds((prev) => new Set(Array.from(prev)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'scan failed');
    } finally {
      setScanning(false);
    }
  }

  // Drag-and-drop upload into the Inbox/ prefix, then re-scan so the new
  // objects land in the review queue.
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function uploadFiles(fileList: FileList | File[]): Promise<void> {
    const picked = Array.from(fileList);
    if (picked.length === 0 || uploading) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      for (const f of picked) {
        const qs = new URLSearchParams({
          filename: f.name,
          mimeType: f.type || 'application/octet-stream',
        });
        // Wire Content-Type is always octet-stream so the global JSON body
        // parser can't intercept e.g. a dropped .json file; the real MIME
        // type travels in the query string.
        const res = await fetch(`${BASE}/upload?${qs.toString()}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-CSRF-Token': getCsrfToken() ?? '',
          },
          body: f,
          credentials: 'same-origin',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(`${f.name}: ${body?.error ?? `upload failed (${res.status})`}`);
        }
      }
      await refresh();
      setNotice(`Uploaded ${picked.length} file${picked.length === 1 ? '' : 's'}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  }

  // 0149 — per-client folder lists for the target-folder dropdown.
  // Fetched lazily the first time a row with that client renders.
  const [clientFolders, setClientFolders] = useState<Record<string, string[]>>({});
  const ensureFolders = useCallback(
    (clientId: string): void => {
      if (!clientId || clientId in clientFolders) return;
      setClientFolders((prev) => ({ ...prev, [clientId]: [] }));
      void api<{ folders: string[] }>(`${BASE}/clients/${clientId}/folders`)
        .then((r) => setClientFolders((prev) => ({ ...prev, [clientId]: r.folders ?? [] })))
        .catch(() => undefined);
    },
    [clientFolders],
  );

  // Optimistic PATCH of a single inbox row.
  async function patchRow(id: string, body: Partial<InboxRow>): Promise<void> {
    setItems((prev) => prev.map((r) => (r.id === id ? { ...r, ...body } : r)));
    try {
      await api<{ ok: boolean }>(`${BASE}/inbox/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      // Client / year edits re-run the routing rules server-side; pull
      // the recomputed destination + status. K-1 client picks need the
      // reload for the joined recipient-client name.
      if (
        body.matchedClient !== undefined ||
        body.overrideYear !== undefined ||
        body.k1MatchedClient !== undefined
      ) {
        void loadInbox();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'update failed');
      // Re-pull authoritative state on failure.
      void loadInbox();
    }
  }

  async function openPreview(id: string): Promise<void> {
    try {
      const r = await api<{ url: string; filename: string }>(`${BASE}/inbox/${id}/preview-url`);
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'preview failed');
    }
  }

  const clientOptions = useMemo(
    () =>
      clients
        .map((c) => ({
          value: c.id,
          label: c.externalId ? `${c.name} · ${c.externalId}` : c.name,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [clients],
  );

  // Distinct value lists for the column filters.
  const statusValues = useMemo(() => {
    const present = new Set(items.map((r) => r.matchStatus));
    return (Object.keys(STATUS_LABELS) as MatchStatus[])
      .filter((s) => present.has(s))
      .map((s) => ({ value: s, label: STATUS_LABELS[s] }));
  }, [items]);
  const clientValues = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of items) if (r.clientName) map.set(r.clientName, r.clientName);
    return Array.from(map.values())
      .sort((a, b) => a.localeCompare(b))
      .map((c) => ({ value: c, label: c }));
  }, [items]);

  const visible = useMemo(
    () =>
      selectRows(items, view, {
        filters: {
          status: (r) => r.matchStatus,
          client: (r) => r.clientName ?? '(unmatched)',
        },
        sortValues: {
          status: (r) => r.matchStatus,
          client: (r) => r.clientName ?? '',
          source: (r) => r.originalName,
        },
        searchText: (r) =>
          `${r.originalName} ${r.clientName ?? ''} ${r.parsedId ?? ''} ${r.parsedName ?? ''}`,
        tieBreak: (a, b) => a.originalName.localeCompare(b.originalName),
      }),
    [items, view],
  );

  const { paged: visiblePaged, pagination: inboxPagination } = useClientPage(visible);
  const visibleIds = useMemo(() => visible.map((r) => r.id), [visible]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  function toggleSelect(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll(): void {
    setSelectedIds((prev) => (allVisibleSelected ? new Set() : new Set([...prev, ...visibleIds])));
  }

  // Rows that will actually be committed: selected (or, if nothing selected,
  // every included row), included, and committable.
  const commitTargets = useMemo(() => {
    const pool = selectedIds.size > 0 ? items.filter((r) => selectedIds.has(r.id)) : items;
    return pool.filter((r) => r.included && isCommittable(r));
  }, [items, selectedIds]);

  const flaggedCount = commitTargets.filter(
    (r) => r.reviewAction === 'flag_tax' || r.reviewAction === 'file_flag_tax',
  ).length;
  const k1Count = commitTargets.filter(
    (r) => r.k1Status === 'confirmed' && r.k1MatchedClient,
  ).length;
  const folderCount = new Set(
    commitTargets.map((r) => r.suggestedPath ?? r.overrideFolder ?? '(client root)'),
  ).size;

  async function bulkSet(action: ReviewAction): Promise<void> {
    const ids = Array.from(selectedIds);
    setItems((prev) =>
      prev.map((r) => (selectedIds.has(r.id) ? { ...r, reviewAction: action } : r)),
    );
    try {
      await Promise.all(
        ids.map((id) =>
          api(`${BASE}/inbox/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ reviewAction: action }),
          }),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'bulk update failed');
      void loadInbox();
    }
  }

  async function doCommit(): Promise<void> {
    const itemIds = commitTargets.map((r) => r.id);
    if (itemIds.length === 0) return;
    setConfirmOpen(false);
    setError(null);
    try {
      const r = await api<{ batchId: string; count: number }>(`${BASE}/commit`, {
        method: 'POST',
        body: JSON.stringify({ itemIds }),
      });
      setNotice(`Routed ${r.count} (batch ${r.batchId})`);
      setSelectedIds(new Set());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'commit failed');
    }
  }

  return (
    <Card
      title={
        <span style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Document inbox</span>
          {activeProfile && (
            <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
              profile: <strong>{activeProfile}</strong>
            </span>
          )}
          {!loading && (
            <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
              {visible.length === items.length
                ? `${items.length} file${items.length === 1 ? '' : 's'}`
                : `${visible.length} of ${items.length}`}
            </span>
          )}
        </span>
      }
      action={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {scanResult && (
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
              scanned {scanResult.scanned} · matched {scanResult.matched}
            </span>
          )}
          <Button variant="secondary" disabled={scanning} onClick={() => void refresh()}>
            {scanning ? 'Scanning…' : 'Refresh'}
          </Button>
        </div>
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>{notice}</p>
      )}

      {!loading && (
        <div
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current += 1;
            setDragActive(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) {
              dragDepth.current = 0;
              setDragActive(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDragActive(false);
            void uploadFiles(e.dataTransfer.files);
          }}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            justifyContent: 'center',
            padding: '14px 12px',
            marginBottom: 12,
            border: `2px dashed ${dragActive ? tokens.color.accent : tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            background: dragActive ? tokens.color.surface : 'transparent',
            color: tokens.color.textMuted,
            fontSize: 13,
          }}
        >
          {uploading ? (
            <span>Uploading…</span>
          ) : (
            <>
              <span>Drag &amp; drop documents here to add them to the inbox, or</span>
              <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
                Browse…
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                aria-label="Upload documents to the inbox"
                style={{ display: 'none' }}
                onChange={(e) => {
                  void uploadFiles(e.target.files ?? []);
                  e.target.value = '';
                }}
              />
            </>
          )}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="Inbox is empty"
          body="Drag and drop documents above (or drop them into the watched bucket and press Refresh) to scan and match them against the active rule profile."
        />
      ) : (
        <>
          <div
            style={{
              marginBottom: 12,
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <TableSearch view={view} placeholder="Search files, clients, IDs…" />
            {view.anyFilterActive && (
              <button
                type="button"
                onClick={() => view.clearFilters()}
                style={{
                  background: 'none',
                  border: 'none',
                  color: tokens.color.accent,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Clear filters
              </button>
            )}
          </div>

          {selectedIds.size > 0 && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                padding: '8px 12px',
                marginBottom: 12,
                background: tokens.color.surface,
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                {selectedIds.size} selected
              </span>
              <Button size="sm" variant="secondary" onClick={() => void bulkSet('flag_tax')}>
                Flag selected for tax
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void bulkSet('file_flag_tax')}>
                File &amp; flag for tax
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void bulkSet('file')}>
                Mark File
              </Button>
              <Button
                size="sm"
                disabled={commitTargets.length === 0}
                onClick={() => setConfirmOpen(true)}
              >
                Commit selected ({commitTargets.length})
              </Button>
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
                fontFamily: tokens.font.body,
              }}
            >
              <thead>
                <tr style={{ background: tokens.color.surface }}>
                  <th style={th('center')}>
                    <input
                      type="checkbox"
                      aria-label="Select all visible files"
                      checked={allVisibleSelected}
                      ref={(el) => {
                        if (el) {
                          const some = visibleIds.some((id) => selectedIds.has(id));
                          el.indeterminate = some && !allVisibleSelected;
                        }
                      }}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th style={th()}>
                    Status{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort status"
                      values={statusValues}
                      selected={view.filterFor('status')}
                      searchable={false}
                      sort={view.sortFor('status')}
                      onApply={(sel, dir) => view.apply('status', sel, dir)}
                    />
                  </th>
                  <th style={th()}>
                    Client{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort client"
                      values={clientValues}
                      selected={view.filterFor('client')}
                      sort={view.sortFor('client')}
                      onApply={(sel, dir) => view.apply('client', sel, dir)}
                    />
                  </th>
                  <th style={th()}>
                    Source{' '}
                    <ColumnFilter
                      ariaLabel="Sort by source name"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('source')}
                      onApply={(_, dir) => view.apply('source', new Set(), dir)}
                    />
                  </th>
                  <th style={th()}>→ Target</th>
                  <th style={th()}>Action</th>
                  <th style={th('center')}>Open</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      style={{
                        textAlign: 'center',
                        padding: 40,
                        color: tokens.color.textMuted,
                        fontSize: 13,
                      }}
                    >
                      <strong>No results</strong>
                      <div>Please refine your filters.</div>
                    </td>
                  </tr>
                ) : (
                  visiblePaged.map((r) => (
                    <InboxRowView
                      key={r.id}
                      row={r}
                      selected={selectedIds.has(r.id)}
                      clientOptions={clientOptions}
                      clientFolders={r.matchedClient ? (clientFolders[r.matchedClient] ?? []) : []}
                      onEnsureFolders={ensureFolders}
                      onToggleSelect={() => toggleSelect(r.id)}
                      onPatch={(body) => void patchRow(r.id, body)}
                      onOpen={() => void openPreview(r.id)}
                    />
                  ))
                )}
              </tbody>
            </table>
            <PaginationBar {...inboxPagination} />
          </div>
        </>
      )}

      {confirmOpen && (
        <CommitConfirmDialog
          count={commitTargets.length}
          folders={folderCount}
          flagged={flaggedCount}
          k1Count={k1Count}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void doCommit()}
        />
      )}
    </Card>
  );
}

// ── A single inbox row ───────────────────────────────────────────────────

function InboxRowView({
  row,
  selected,
  clientOptions,
  clientFolders,
  onEnsureFolders,
  onToggleSelect,
  onPatch,
  onOpen,
}: {
  row: InboxRow;
  selected: boolean;
  clientOptions: Array<{ value: string; label: string }>;
  clientFolders: string[];
  onEnsureFolders: (clientId: string) => void;
  onToggleSelect: () => void;
  onPatch: (body: Partial<InboxRow>) => void;
  onOpen: () => void;
}): JSX.Element {
  // Load the matched client's folder list once it's known, so the
  // target-folder dropdown is populated by the time it's opened.
  useEffect(() => {
    if (row.matchedClient) onEnsureFolders(row.matchedClient);
  }, [row.matchedClient, onEnsureFolders]);
  const needsClient = row.matchStatus === 'unparseable' || !row.matchedClient;
  // Unparseable rows can't be included until a client is manually assigned.
  const includeDisabled = row.matchStatus === 'unparseable' && !row.matchedClient;
  const target = row.suggestedPath ?? row.overrideFolder ?? '(client root)';

  return (
    <tr style={{ borderTop: `1px solid ${tokens.color.border}` }}>
      <td style={{ ...td(), textAlign: 'center' }}>
        <input
          type="checkbox"
          aria-label={`Select ${row.originalName}`}
          checked={selected}
          disabled={includeDisabled}
          onChange={onToggleSelect}
        />
      </td>

      <td style={td()}>
        <Pill tone={statusTone(row.matchStatus)}>{STATUS_LABELS[row.matchStatus]}</Pill>
      </td>

      <td style={td()}>
        {needsClient ? (
          <div style={{ minWidth: 220 }}>
            <Combobox
              ariaLabel={`Assign client for ${row.originalName}`}
              clearable
              value={row.matchedClient ?? ''}
              onChange={(v) => onPatch({ matchedClient: v || null })}
              options={clientOptions}
              placeholder="Assign client…"
            />
          </div>
        ) : (
          <div>
            <div style={{ fontWeight: 500 }}>{row.clientName}</div>
            {(row.clientExternalId ?? row.clientAwsId) && (
              <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                · ID {row.clientExternalId ?? row.clientAwsId}
              </div>
            )}
          </div>
        )}
        {row.k1RecipientName && (
          <K1RecipientControls row={row} clientOptions={clientOptions} onPatch={onPatch} />
        )}
      </td>

      <td style={td()}>
        <div>{row.originalName}</div>
        <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
          {formatSize(row.sizeBytes)}
        </div>
      </td>

      <td style={td()}>
        <div style={{ display: 'grid', gap: 4, minWidth: 200 }}>
          <div style={{ color: tokens.color.textMuted }}>{target}</div>
          {row.matchStatus === 'year_needed' && (
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
              <span style={{ color: tokens.color.textMuted }}>Year</span>
              <input
                type="number"
                aria-label="Override year"
                defaultValue={row.overrideYear ?? row.parsedYear ?? ''}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  onPatch({ overrideYear: v ? Number(v) : null });
                }}
                style={{ ...controlStyle, width: 90 }}
              />
            </label>
          )}
          <input
            type="text"
            aria-label="Override folder"
            placeholder="Target folder (client folders listed)"
            defaultValue={row.overrideFolder ?? ''}
            list={`folders-${row.id}`}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (row.overrideFolder ?? '')) onPatch({ overrideFolder: v || null });
            }}
            style={{ ...controlStyle, width: '100%' }}
          />
          <datalist id={`folders-${row.id}`}>
            {clientFolders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
      </td>

      <td style={td()}>
        <div style={{ display: 'grid', gap: 4, minWidth: 150 }}>
          <select
            aria-label="Review action"
            value={row.reviewAction ?? ''}
            onChange={(e) => onPatch({ reviewAction: (e.target.value || null) as ReviewAction })}
            style={controlStyle}
          >
            <option value="">— choose —</option>
            <option value="file">File</option>
            <option value="flag_tax">Flag for tax</option>
            <option value="file_flag_tax">File &amp; flag for tax</option>
            <option value="skip">Skip</option>
          </select>
          {(row.reviewAction === 'flag_tax' || row.reviewAction === 'file_flag_tax') && (
            <div style={{ display: 'grid', gap: 4 }}>
              <input
                type="text"
                aria-label="Form code"
                placeholder="Form code"
                defaultValue={row.flagFormCode ?? ''}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (row.flagFormCode ?? '')) onPatch({ flagFormCode: v || null });
                }}
                style={controlStyle}
              />
              <input
                type="number"
                aria-label="Tax year"
                placeholder="Tax year"
                defaultValue={row.flagTaxYear ?? ''}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  onPatch({ flagTaxYear: v ? Number(v) : null });
                }}
                style={controlStyle}
              />
            </div>
          )}
        </div>
      </td>

      <td style={{ ...td(), textAlign: 'center' }}>
        <Button size="sm" variant="ghost" onClick={onOpen}>
          Open
        </Button>
      </td>
    </tr>
  );
}

// ── K-1 recipient verify / search / dismiss (0229) ───────────────────────
//
// Rendered under the primary client when the filename carries a
// `K1_Package_` recipient. A confirmed recipient gets an additional copy
// of the PDF in their own folder at commit; unverified/dismissed
// suggestions are never copied.

function K1RecipientControls({
  row,
  clientOptions,
  onPatch,
}: {
  row: InboxRow;
  clientOptions: Array<{ value: string; label: string }>;
  onPatch: (body: Partial<InboxRow>) => void;
}): JSX.Element {
  const [searching, setSearching] = useState(false);
  // The recipient copy can't target the entity itself.
  const options = useMemo(
    () => clientOptions.filter((o) => o.value !== row.matchedClient),
    [clientOptions, row.matchedClient],
  );
  const muted: React.CSSProperties = { fontSize: 11, color: tokens.color.textMuted };
  const actionRow: React.CSSProperties = {
    display: 'flex',
    gap: 4,
    alignItems: 'center',
    flexWrap: 'wrap',
  };

  return (
    <div
      style={{
        marginTop: 6,
        paddingTop: 6,
        borderTop: `1px dashed ${tokens.color.border}`,
        display: 'grid',
        gap: 4,
      }}
    >
      <div style={muted}>
        K-1 recipient: <strong style={{ color: tokens.color.text }}>{row.k1RecipientName}</strong>
      </div>

      {searching ? (
        <div style={{ ...actionRow, minWidth: 220 }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <Combobox
              ariaLabel={`Pick K-1 recipient client for ${row.originalName}`}
              clearable
              value={row.k1MatchedClient ?? ''}
              onChange={(v) => {
                if (v) onPatch({ k1MatchedClient: v, k1Status: 'confirmed' });
                setSearching(false);
              }}
              options={options}
              placeholder="Pick recipient client…"
            />
          </div>
          <Button size="sm" variant="ghost" onClick={() => setSearching(false)}>
            Cancel
          </Button>
        </div>
      ) : row.k1Status === 'confirmed' ? (
        <div style={actionRow}>
          <Pill tone="success">✓ {row.k1ClientName ?? 'recipient'}</Pill>
          <Button size="sm" variant="ghost" onClick={() => setSearching(true)}>
            Change
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onPatch({ k1Status: 'dismissed' })}>
            Dismiss
          </Button>
        </div>
      ) : row.k1Status === 'dismissed' ? (
        <div style={actionRow}>
          <span style={muted}>K-1 copy dismissed</span>
          <Button size="sm" variant="ghost" onClick={() => onPatch({ k1Status: 'suggested' })}>
            Restore
          </Button>
        </div>
      ) : (
        <div style={actionRow}>
          {row.k1MatchedClient ? (
            <>
              <span style={{ fontSize: 12 }}>{row.k1ClientName}</span>
              {row.k1MatchScore != null && (
                <Pill tone="warning">{Math.round(row.k1MatchScore * 100)}%</Pill>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onPatch({ k1Status: 'confirmed' })}
              >
                Verify
              </Button>
            </>
          ) : (
            <span style={muted}>no match</span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSearching(true)}>
            Search
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onPatch({ k1Status: 'dismissed' })}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Commit confirmation modal ────────────────────────────────────────────

function CommitConfirmDialog({
  count,
  folders,
  flagged,
  k1Count,
  onCancel,
  onConfirm,
}: {
  count: number;
  folders: number;
  flagged: number;
  k1Count: number;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
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
        paddingTop: 80,
        zIndex: 200,
      }}
    >
      <div style={{ minWidth: 460, maxWidth: 560 }}>
        <Card title="Commit routing batch">
          <div style={{ display: 'grid', gap: 16 }}>
            <p style={{ fontSize: 14, margin: 0, lineHeight: 1.5 }}>
              Route <strong>{count}</strong> file{count === 1 ? '' : 's'} to{' '}
              <strong>{folders}</strong> folder{folders === 1 ? '' : 's'}
              {flagged > 0 ? (
                <>
                  {' '}
                  (<strong>{flagged}</strong> flagged for tax processing)
                </>
              ) : null}
              {k1Count > 0 ? (
                <>
                  {' '}
                  (<strong>{k1Count}</strong> K-1 recipient cop{k1Count === 1 ? 'y' : 'ies'})
                </>
              ) : null}
              ? Files are relocated in B2; this is undoable from History.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button onClick={onConfirm} disabled={count === 0}>
                Route {count} file{count === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Import tab (0153) — zip import
// ═══════════════════════════════════════════════════════════════════════

type ZipImportStatus = 'draft' | 'queued' | 'running' | 'done' | 'error';

interface ZipImportRow {
  id: string;
  zipName: string;
  zipSizeBytes: number;
  matchedClient: string | null;
  clientName: string | null;
  destFolder: string | null;
  status: ZipImportStatus;
  totalEntries: number | null;
  importedCount: number | null;
  skippedCount: number | null;
  errorCount: number | null;
  error: string | null;
  createdAt: string;
}

interface ZipImportResult {
  path: string;
  status: 'imported' | 'skipped' | 'error';
  detail?: string;
}

const IMPORT_STATUS_TONE: Record<ZipImportStatus, 'success' | 'warning' | 'danger'> = {
  draft: 'warning',
  queued: 'warning',
  running: 'warning',
  done: 'success',
  error: 'danger',
};

function ImportTab(): JSX.Element {
  const [imports, setImports] = useState<ZipImportRow[]>([]);
  const [clients, setClients] = useState<ClientPick[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The import being configured (after upload) or watched (after start).
  const [draft, setDraft] = useState<{
    id: string;
    zipName: string;
    sizeBytes: number;
    status: ZipImportStatus;
  } | null>(null);
  const [selectedClient, setSelectedClient] = useState<string>('');
  const [destFolder, setDestFolder] = useState<string>('');
  const [folders, setFolders] = useState<string[]>([]);
  const [active, setActive] = useState<
    (ZipImportRow & { results: ZipImportResult[] | null }) | null
  >(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ZipImportResult[] | null>>({});

  const loadImports = useCallback(async (): Promise<void> => {
    const r = await api<{ items: ZipImportRow[] }>(`${BASE}/import`);
    setImports(r.items ?? []);
  }, []);

  useEffect(() => {
    void loadImports().catch((err) =>
      setError(err instanceof Error ? err.message : 'failed to load imports'),
    );
    void api<{ rows?: ClientPick[]; items?: ClientPick[] }>('/api/staff/clients/picker')
      .then((r) => setClients(r.rows ?? r.items ?? []))
      .catch(() => undefined);
  }, [loadImports]);

  // Folder list for the destination dropdown follows the chosen client.
  useEffect(() => {
    if (!selectedClient) {
      setFolders([]);
      return;
    }
    void api<{ folders: string[] }>(`${BASE}/clients/${selectedClient}/folders`)
      .then((r) => setFolders(r.folders ?? []))
      .catch(() => setFolders([]));
  }, [selectedClient]);

  // Poll the active import while the worker is on it.
  useEffect(() => {
    if (!active || (active.status !== 'queued' && active.status !== 'running')) return;
    const t = setInterval(() => {
      void api<{ item: ZipImportRow & { results: ZipImportResult[] | null } }>(
        `${BASE}/import/${active.id}`,
      )
        .then((r) => {
          setActive(r.item);
          if (r.item.status === 'done' || r.item.status === 'error') void loadImports();
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [active, loadImports]);

  async function uploadZip(fileList: FileList | File[]): Promise<void> {
    const f = Array.from(fileList)[0];
    if (!f || uploading) return;
    if (!f.name.toLowerCase().endsWith('.zip')) {
      setError('Please choose a .zip file.');
      return;
    }
    setUploading(true);
    setError(null);
    setActive(null);
    try {
      const qs = new URLSearchParams({ filename: f.name });
      const res = await fetch(`${BASE}/import/upload?${qs.toString()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-CSRF-Token': getCsrfToken() ?? '',
        },
        body: f,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `upload failed (${res.status})`);
      }
      const r = (await res.json()) as {
        id: string;
        zipName: string;
        sizeBytes: number;
        matchedClient: string | null;
      };
      setDraft({ id: r.id, zipName: r.zipName, sizeBytes: r.sizeBytes, status: 'draft' });
      setSelectedClient(r.matchedClient ?? '');
      setDestFolder('');
      await loadImports();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function startImport(): Promise<void> {
    if (!draft || !selectedClient) return;
    setError(null);
    try {
      await api(`${BASE}/import/${draft.id}/start`, {
        method: 'POST',
        body: JSON.stringify({ clientId: selectedClient, destFolder: destFolder.trim() }),
      });
      const r = await api<{ item: ZipImportRow & { results: ZipImportResult[] | null } }>(
        `${BASE}/import/${draft.id}`,
      );
      setActive(r.item);
      setDraft(null);
      await loadImports();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'start failed');
    }
  }

  async function toggleExpand(id: string): Promise<void> {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!(id in details)) {
      try {
        const r = await api<{ item: { results: ZipImportResult[] | null } }>(
          `${BASE}/import/${id}`,
        );
        setDetails((prev) => ({ ...prev, [id]: r.item.results }));
      } catch {
        setDetails((prev) => ({ ...prev, [id]: null }));
      }
    }
  }

  const clientOptions = useMemo(
    () =>
      clients
        .map((c) => ({ value: c.id, label: c.externalId ? `${c.name} · ${c.externalId}` : c.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [clients],
  );

  const { paged: impPaged, pagination: impPagination } = useClientPage(imports);

  return (
    <Card title="Import a document zip">
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}

      <div style={{ display: 'grid', gap: 16 }}>
        <div
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current += 1;
            setDragActive(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) {
              dragDepth.current = 0;
              setDragActive(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDragActive(false);
            void uploadZip(e.dataTransfer.files);
          }}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            justifyContent: 'center',
            padding: '18px 12px',
            border: `2px dashed ${dragActive ? tokens.color.accent : tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            background: dragActive ? tokens.color.surface : 'transparent',
            color: tokens.color.textMuted,
            fontSize: 13,
          }}
        >
          {uploading ? (
            <span>Uploading…</span>
          ) : (
            <>
              <span>Drag &amp; drop a .zip here, or</span>
              <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
                Browse…
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                aria-label="Upload a zip to import"
                style={{ display: 'none' }}
                onChange={(e) => {
                  void uploadZip(e.target.files ?? []);
                  e.target.value = '';
                }}
              />
            </>
          )}
        </div>

        {draft && (
          <div
            style={{
              display: 'grid',
              gap: 12,
              padding: 12,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
            }}
          >
            <strong style={{ fontSize: 13 }}>
              {draft.zipName}{' '}
              <span style={{ color: tokens.color.textMuted, fontWeight: 400 }}>
                ({formatSize(draft.sizeBytes)})
              </span>
            </strong>
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={labelStyle}>
                  Client {selectedClient ? '(matched from zip name)' : '— no match, choose one'}
                </label>
                <Combobox
                  ariaLabel="Import client"
                  value={selectedClient}
                  onChange={setSelectedClient}
                  options={clientOptions}
                  placeholder="Select client…"
                />
              </div>
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={labelStyle}>
                  Destination folder (zip structure preserved underneath)
                </label>
                <input
                  type="text"
                  aria-label="Destination folder"
                  placeholder="e.g. Payroll"
                  value={destFolder}
                  onChange={(e) => setDestFolder(e.target.value)}
                  list="zip-import-folders"
                  style={controlStyle}
                />
                <datalist id="zip-import-folders">
                  {folders.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button disabled={!selectedClient} onClick={() => void startImport()}>
                Start import
              </Button>
            </div>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              Existing files with the same name are never overwritten — they are skipped and listed
              in the result. Imported files start internal-only (not visible in the portal).
            </p>
          </div>
        )}

        {active && (
          <div
            style={{
              display: 'grid',
              gap: 8,
              padding: 12,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Pill tone={IMPORT_STATUS_TONE[active.status]}>{active.status}</Pill>
              <strong style={{ fontSize: 13 }}>{active.zipName}</strong>
              {(active.status === 'queued' || active.status === 'running') && (
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>extracting…</span>
              )}
              {active.status === 'done' && (
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  {active.importedCount} imported · {active.skippedCount} skipped ·{' '}
                  {active.errorCount} errors
                </span>
              )}
              {active.status === 'error' && (
                <span style={{ fontSize: 12, color: tokens.color.danger }}>{active.error}</span>
              )}
            </div>
            {active.results && active.results.length > 0 && (
              <ImportResults results={active.results} />
            )}
          </div>
        )}

        {/* Recent imports */}
        {imports.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
                fontFamily: tokens.font.body,
              }}
            >
              <thead>
                <tr style={{ background: tokens.color.surface }}>
                  <th style={th('center')}>{''}</th>
                  <th style={th()}>When</th>
                  <th style={th()}>Zip</th>
                  <th style={th()}>Client</th>
                  <th style={th()}>Folder</th>
                  <th style={th()}>Status</th>
                  <th style={th('right')}>Imported / skipped / errors</th>
                </tr>
              </thead>
              <tbody>
                {impPaged.map((row) => {
                  const open = expanded === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                        <td style={{ ...td(), textAlign: 'center' }}>
                          <button
                            type="button"
                            aria-label={open ? 'Collapse' : 'Expand'}
                            onClick={() => void toggleExpand(row.id)}
                            style={iconBtn(false)}
                          >
                            {open ? '▾' : '▸'}
                          </button>
                        </td>
                        <td style={td()}>{new Date(row.createdAt).toLocaleString()}</td>
                        <td style={td()}>
                          <div>{row.zipName}</div>
                          <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                            {formatSize(row.zipSizeBytes)}
                          </div>
                        </td>
                        <td style={td()}>{row.clientName ?? '—'}</td>
                        <td style={td()}>{row.destFolder || '(client root)'}</td>
                        <td style={td()}>
                          <Pill tone={IMPORT_STATUS_TONE[row.status]}>{row.status}</Pill>
                        </td>
                        <td style={{ ...td(), textAlign: 'right' }}>
                          {row.status === 'done' || row.status === 'error'
                            ? `${row.importedCount ?? 0} / ${row.skippedCount ?? 0} / ${row.errorCount ?? 0}`
                            : '—'}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={7} style={{ padding: 0 }}>
                            {details[row.id] === undefined ? (
                              <div
                                style={{
                                  padding: 12,
                                  fontSize: 12,
                                  color: tokens.color.textMuted,
                                }}
                              >
                                Loading…
                              </div>
                            ) : details[row.id] && details[row.id]!.length > 0 ? (
                              <div style={{ background: tokens.color.surface, padding: 12 }}>
                                <ImportResults results={details[row.id]!} />
                              </div>
                            ) : (
                              <div
                                style={{
                                  padding: 12,
                                  fontSize: 12,
                                  color: tokens.color.textMuted,
                                }}
                              >
                                No per-file results recorded.
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <PaginationBar {...impPagination} />
          </div>
        )}
      </div>
    </Card>
  );
}

const IMPORT_RESULT_TONE: Record<ZipImportResult['status'], 'success' | 'warning' | 'danger'> = {
  imported: 'success',
  skipped: 'warning',
  error: 'danger',
};

function ImportResults({ results }: { results: ZipImportResult[] }): JSX.Element {
  return (
    <ScrollX>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={th()}>File</th>
            <th style={th()}>Result</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.path} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
              <td style={{ ...td(), fontFamily: tokens.font.mono, fontSize: 11 }}>{r.path}</td>
              <td style={td()}>
                <Pill tone={IMPORT_RESULT_TONE[r.status]}>{r.status}</Pill>
                {r.detail && (
                  <span style={{ fontSize: 11, color: tokens.color.textMuted, marginLeft: 6 }}>
                    {r.detail}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollX>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Rules tab
// ═══════════════════════════════════════════════════════════════════════

const MATCH_MODE_OPTIONS: Array<{ value: MatchMode; label: string }> = [
  { value: 'contains', label: 'Contains' },
  { value: 'starts_with', label: 'Starts with' },
  { value: 'regex', label: 'Regex' },
];
const YEAR_BEHAVIOR_OPTIONS: Array<{ value: YearBehavior; label: string }> = [
  { value: 'none', label: 'No year' },
  { value: 'current_only', label: 'Current only' },
  { value: 'current_and_next', label: 'Current and next' },
  { value: 'previous', label: 'Previous' },
];

function RulesTab(): JSX.Element {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [renaming, setRenaming] = useState(false);

  const loadProfiles = useCallback(async (): Promise<Profile[]> => {
    const r = await api<{ items: Profile[] }>(`${BASE}/profiles`);
    setProfiles(r.items ?? []);
    return r.items ?? [];
  }, []);

  const loadRules = useCallback(async (profileId: string): Promise<void> => {
    if (!profileId) {
      setRules([]);
      return;
    }
    const r = await api<{ items: Rule[] }>(
      `${BASE}/rules?profileId=${encodeURIComponent(profileId)}`,
    );
    setRules([...(r.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const ps = await loadProfiles();
        const initial = ps.find((p) => p.isActive)?.id ?? ps[0]?.id ?? '';
        setSelectedProfileId(initial);
        await loadRules(initial);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load rules');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadProfiles, loadRules]);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? null;

  async function selectProfile(id: string): Promise<void> {
    setSelectedProfileId(id);
    try {
      await loadRules(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load rules');
    }
  }

  async function newProfile(): Promise<void> {
    const name = window.prompt('New profile name');
    if (!name?.trim()) return;
    try {
      const r = await api<{ id: string }>(`${BASE}/profiles`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      await loadProfiles();
      await selectProfile(r.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create profile failed');
    }
  }

  async function setActive(): Promise<void> {
    if (!selectedProfile) return;
    try {
      await api(`${BASE}/profiles/${selectedProfile.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: true }),
      });
      await loadProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'set active failed');
    }
  }

  async function renameProfile(name: string): Promise<void> {
    if (!selectedProfile || !name.trim()) return;
    try {
      await api(`${BASE}/profiles/${selectedProfile.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      });
      setRenaming(false);
      await loadProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'rename failed');
    }
  }

  async function deleteProfile(): Promise<void> {
    if (!selectedProfile) return;
    if (!window.confirm(`Delete profile "${selectedProfile.name}"? This removes its rules.`))
      return;
    try {
      await api(`${BASE}/profiles/${selectedProfile.id}`, { method: 'DELETE' });
      const ps = await loadProfiles();
      const next = ps[0]?.id ?? '';
      await selectProfile(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete profile failed');
    }
  }

  async function reorder(index: number, dir: -1 | 1): Promise<void> {
    const next = index + dir;
    if (next < 0 || next >= rules.length) return;
    const reordered = [...rules];
    const [moved] = reordered.splice(index, 1);
    if (!moved) return;
    reordered.splice(next, 0, moved);
    setRules(reordered);
    try {
      await api(`${BASE}/rules/reorder`, {
        method: 'POST',
        body: JSON.stringify({
          profileId: selectedProfileId,
          orderedIds: reordered.map((r) => r.id),
        }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reorder failed');
      await loadRules(selectedProfileId);
    }
  }

  async function toggleEnabled(rule: Rule): Promise<void> {
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)));
    try {
      await api(`${BASE}/rules/${rule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'toggle failed');
      await loadRules(selectedProfileId);
    }
  }

  async function deleteRule(rule: Rule): Promise<void> {
    if (!window.confirm(`Delete rule "${rule.name}"?`)) return;
    try {
      await api(`${BASE}/rules/${rule.id}`, { method: 'DELETE' });
      await loadRules(selectedProfileId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete failed');
    }
  }

  // 0229 — destination config for K-1 recipient copies.
  async function patchK1Config(body: {
    k1TargetPath?: string;
    k1YearBehavior?: YearBehavior;
  }): Promise<void> {
    if (!selectedProfile) return;
    try {
      await api(`${BASE}/profiles/${selectedProfile.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await loadProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'K-1 settings update failed');
    }
  }

  return (
    <Card title="Routing rules">
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* Profile selector + actions */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              paddingBottom: 12,
              borderBottom: `1px solid ${tokens.color.border}`,
            }}
          >
            <div style={{ minWidth: 240 }}>
              <Combobox
                ariaLabel="Rule profile"
                value={selectedProfileId}
                onChange={(v) => void selectProfile(v)}
                options={profiles.map((p) => ({
                  value: p.id,
                  label: p.isActive ? `${p.name} (active)` : p.name,
                }))}
                placeholder="Select profile…"
              />
            </div>
            {selectedProfile?.isActive ? (
              <Pill tone="success">active</Pill>
            ) : (
              selectedProfile && (
                <Button size="sm" variant="secondary" onClick={() => void setActive()}>
                  Set active
                </Button>
              )
            )}
            {selectedProfile &&
              (renaming ? (
                <RenameInline
                  initial={selectedProfile.name}
                  onCancel={() => setRenaming(false)}
                  onSave={(n) => void renameProfile(n)}
                />
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
                  Rename
                </Button>
              ))}
            {selectedProfile && (
              <Button size="sm" variant="ghost" onClick={() => void deleteProfile()}>
                Delete
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => void newProfile()}>
              + New profile
            </Button>
          </div>

          {/* K-1 recipient copy destination (0229) */}
          {selectedProfile && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                flexWrap: 'wrap',
                paddingBottom: 12,
                borderBottom: `1px solid ${tokens.color.border}`,
              }}
            >
              <span style={{ fontSize: 12, color: tokens.color.textMuted, fontWeight: 600 }}>
                K-1 recipient copies
              </span>
              <input
                type="text"
                key={`k1-path-${selectedProfile.id}`}
                aria-label="K-1 recipient target path"
                defaultValue={selectedProfile.k1TargetPath}
                placeholder="Income Tax"
                onBlur={(e) => {
                  const v = e.target.value.trim() || 'Income Tax';
                  if (v !== selectedProfile.k1TargetPath) void patchK1Config({ k1TargetPath: v });
                }}
                style={{ ...controlStyle, width: 200 }}
              />
              <select
                aria-label="K-1 recipient year behavior"
                value={selectedProfile.k1YearBehavior}
                onChange={(e) =>
                  void patchK1Config({ k1YearBehavior: e.target.value as YearBehavior })
                }
                style={controlStyle}
              >
                {YEAR_BEHAVIOR_OPTIONS.map((y) => (
                  <option key={y.value} value={y.value}>
                    {y.label}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                Where a verified K-1 recipient&apos;s copy is filed in their folder.
              </span>
            </div>
          )}

          {/* Rules list */}
          {!selectedProfileId ? (
            <EmptyState title="No profile selected" body="Create or select a rule profile above." />
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 13,
                    fontFamily: tokens.font.body,
                  }}
                >
                  <thead>
                    <tr style={{ background: tokens.color.surface }}>
                      <th style={th('center')}>Order</th>
                      <th style={th()}>Name</th>
                      <th style={th()}>Identifier</th>
                      <th style={th()}>Mode</th>
                      <th style={th()}>Target path</th>
                      <th style={th()}>Year</th>
                      <th style={th('center')}>Tax</th>
                      <th style={th('center')}>Enabled</th>
                      <th style={th('right')}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.length === 0 ? (
                      <tr>
                        <td
                          colSpan={9}
                          style={{
                            textAlign: 'center',
                            padding: 32,
                            color: tokens.color.textMuted,
                          }}
                        >
                          No rules yet. Add one below.
                        </td>
                      </tr>
                    ) : (
                      rules.map((rule, i) => (
                        <tr key={rule.id} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                          <td style={{ ...td(), textAlign: 'center', whiteSpace: 'nowrap' }}>
                            <button
                              type="button"
                              aria-label="Move up"
                              disabled={i === 0}
                              onClick={() => void reorder(i, -1)}
                              style={iconBtn(i === 0)}
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              aria-label="Move down"
                              disabled={i === rules.length - 1}
                              onClick={() => void reorder(i, 1)}
                              style={iconBtn(i === rules.length - 1)}
                            >
                              ▼
                            </button>
                          </td>
                          <td style={td()}>{rule.name}</td>
                          <td style={td()}>
                            <code style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>
                              {rule.identifier}
                            </code>
                          </td>
                          <td style={td()}>
                            {MATCH_MODE_OPTIONS.find((m) => m.value === rule.matchMode)?.label}
                            {rule.caseSensitive ? ' · Aa' : ''}
                          </td>
                          <td style={td()}>{rule.targetPath}</td>
                          <td style={td()}>
                            {
                              YEAR_BEHAVIOR_OPTIONS.find((y) => y.value === rule.yearBehavior)
                                ?.label
                            }
                          </td>
                          <td style={{ ...td(), textAlign: 'center' }}>
                            {rule.isTaxReturn ? <Pill tone="accent">tax</Pill> : '—'}
                          </td>
                          <td style={{ ...td(), textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              aria-label={`Enable ${rule.name}`}
                              checked={rule.enabled}
                              onChange={() => void toggleEnabled(rule)}
                            />
                          </td>
                          <td style={{ ...td(), textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(rule)}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => void deleteRule(rule)}>
                              Delete
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {addOpen ? (
                <RuleForm
                  profileId={selectedProfileId}
                  onCancel={() => setAddOpen(false)}
                  onSaved={async () => {
                    setAddOpen(false);
                    await loadRules(selectedProfileId);
                  }}
                  onError={setError}
                />
              ) : (
                <div>
                  <Button variant="secondary" onClick={() => setAddOpen(true)}>
                    + Add rule
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {editing && (
        <RuleEditDialog
          rule={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await loadRules(selectedProfileId);
          }}
          onError={setError}
        />
      )}
    </Card>
  );
}

function iconBtn(disabled: boolean): React.CSSProperties {
  return {
    background: 'none',
    border: 'none',
    color: disabled ? tokens.color.textMuted : tokens.color.accent,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 12,
    padding: '0 4px',
    opacity: disabled ? 0.4 : 1,
  };
}

function RenameInline({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}): JSX.Element {
  const [name, setName] = useState(initial);
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <input
        type="text"
        aria-label="Profile name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ ...controlStyle, width: 180 }}
      />
      <Button size="sm" onClick={() => onSave(name)}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </span>
  );
}

// ── Rule create/edit form ────────────────────────────────────────────────

interface RuleDraft {
  name: string;
  identifier: string;
  matchMode: MatchMode;
  caseSensitive: boolean;
  targetPath: string;
  yearBehavior: YearBehavior;
  isTaxReturn: boolean;
  enabled: boolean;
  notes: string;
}

const labelStyle: React.CSSProperties = { fontSize: 11, color: tokens.color.textMuted };

function fieldGrid(): React.CSSProperties {
  return { display: 'grid', gap: 4 };
}

function RuleFields({
  draft,
  setDraft,
}: {
  draft: RuleDraft;
  setDraft: React.Dispatch<React.SetStateAction<RuleDraft>>;
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
      <div style={fieldGrid()}>
        <label style={labelStyle}>Name</label>
        <input
          type="text"
          aria-label="Rule name"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          style={controlStyle}
        />
      </div>
      <div style={fieldGrid()}>
        <label style={labelStyle}>Identifier</label>
        <input
          type="text"
          aria-label="Identifier"
          value={draft.identifier}
          onChange={(e) => setDraft((d) => ({ ...d, identifier: e.target.value }))}
          style={controlStyle}
        />
      </div>
      <div style={fieldGrid()}>
        <label style={labelStyle}>Match mode</label>
        <select
          aria-label="Match mode"
          value={draft.matchMode}
          onChange={(e) => setDraft((d) => ({ ...d, matchMode: e.target.value as MatchMode }))}
          style={controlStyle}
        >
          {MATCH_MODE_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div style={fieldGrid()}>
        <label style={labelStyle}>Target path</label>
        <input
          type="text"
          aria-label="Target path"
          value={draft.targetPath}
          onChange={(e) => setDraft((d) => ({ ...d, targetPath: e.target.value }))}
          style={controlStyle}
        />
      </div>
      <div style={fieldGrid()}>
        <label style={labelStyle}>Year behavior</label>
        <select
          aria-label="Year behavior"
          value={draft.yearBehavior}
          onChange={(e) =>
            setDraft((d) => ({ ...d, yearBehavior: e.target.value as YearBehavior }))
          }
          style={controlStyle}
        >
          {YEAR_BEHAVIOR_OPTIONS.map((y) => (
            <option key={y.value} value={y.value}>
              {y.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', paddingTop: 18 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={draft.caseSensitive}
            onChange={(e) => setDraft((d) => ({ ...d, caseSensitive: e.target.checked }))}
          />
          Case sensitive
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={draft.isTaxReturn}
            onChange={(e) => setDraft((d) => ({ ...d, isTaxReturn: e.target.checked }))}
          />
          Tax return
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
          />
          Enabled
        </label>
      </div>
      <div style={{ ...fieldGrid(), gridColumn: '1 / -1' }}>
        <label style={labelStyle}>Notes</label>
        <textarea
          aria-label="Notes"
          rows={2}
          value={draft.notes}
          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
          style={{ ...controlStyle, resize: 'vertical' }}
        />
      </div>
    </div>
  );
}

const EMPTY_DRAFT: RuleDraft = {
  name: '',
  identifier: '',
  matchMode: 'contains',
  caseSensitive: false,
  targetPath: '',
  yearBehavior: 'none',
  isTaxReturn: false,
  enabled: true,
  notes: '',
};

function RuleForm({
  profileId,
  onCancel,
  onSaved,
  onError,
}: {
  profileId: string;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onError: (msg: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    if (!draft.name.trim() || !draft.identifier.trim() || !draft.targetPath.trim()) {
      onError('Name, identifier, and target path are required.');
      return;
    }
    setBusy(true);
    try {
      await api(`${BASE}/rules`, {
        method: 'POST',
        body: JSON.stringify({
          profileId,
          name: draft.name.trim(),
          identifier: draft.identifier.trim(),
          matchMode: draft.matchMode,
          caseSensitive: draft.caseSensitive,
          targetPath: draft.targetPath.trim(),
          yearBehavior: draft.yearBehavior,
          isTaxReturn: draft.isTaxReturn,
          enabled: draft.enabled,
          notes: draft.notes.trim() || null,
        }),
      });
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'create rule failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'grid',
        gap: 12,
        padding: 12,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.surface,
      }}
    >
      <strong style={{ fontSize: 13 }}>New rule</strong>
      <RuleFields draft={draft} setDraft={setDraft} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Add rule'}
        </Button>
      </div>
    </div>
  );
}

function RuleEditDialog({
  rule,
  onClose,
  onSaved,
  onError,
}: {
  rule: Rule;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (msg: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<RuleDraft>({
    name: rule.name,
    identifier: rule.identifier,
    matchMode: rule.matchMode,
    caseSensitive: rule.caseSensitive,
    targetPath: rule.targetPath,
    yearBehavior: rule.yearBehavior,
    isTaxReturn: rule.isTaxReturn,
    enabled: rule.enabled,
    notes: rule.notes ?? '',
  });
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    if (!draft.name.trim() || !draft.identifier.trim() || !draft.targetPath.trim()) {
      onError('Name, identifier, and target path are required.');
      return;
    }
    setBusy(true);
    try {
      await api(`${BASE}/rules/${rule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: draft.name.trim(),
          identifier: draft.identifier.trim(),
          matchMode: draft.matchMode,
          caseSensitive: draft.caseSensitive,
          targetPath: draft.targetPath.trim(),
          yearBehavior: draft.yearBehavior,
          isTaxReturn: draft.isTaxReturn,
          enabled: draft.enabled,
          notes: draft.notes.trim() || null,
        }),
      });
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'update rule failed');
    } finally {
      setBusy(false);
    }
  }

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
      <div style={{ minWidth: 560, maxWidth: 720, maxHeight: '85vh', overflow: 'auto' }}>
        <Card title={`Edit rule — ${rule.name}`}>
          <div style={{ display: 'grid', gap: 12 }}>
            <RuleFields draft={draft} setDraft={setDraft} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// History tab
// ═══════════════════════════════════════════════════════════════════════

function HistoryTab(): JSX.Element {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogRow[]>>({});

  const load = useCallback(async (): Promise<void> => {
    const r = await api<{ items: BatchRow[] }>(`${BASE}/history`);
    setBatches(r.items ?? []);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load history');
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  async function toggleExpand(batchId: string): Promise<void> {
    if (expanded === batchId) {
      setExpanded(null);
      return;
    }
    setExpanded(batchId);
    if (!logs[batchId]) {
      try {
        const r = await api<{ items: LogRow[] }>(`${BASE}/history/${batchId}`);
        setLogs((prev) => ({ ...prev, [batchId]: r.items ?? [] }));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load batch detail');
      }
    }
  }

  async function undoBatch(batchId: string): Promise<void> {
    if (!window.confirm('Undo this batch? Filed documents are moved back to the inbox bucket.')) {
      return;
    }
    try {
      await api<{ count: number }>(`${BASE}/history/${batchId}/undo`, { method: 'POST' });
      // Refresh both the batch summary and any open detail rows.
      await load();
      const r = await api<{ items: LogRow[] }>(`${BASE}/history/${batchId}`);
      setLogs((prev) => ({ ...prev, [batchId]: r.items ?? [] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'undo failed');
    }
  }

  async function undoLog(batchId: string, logId: string): Promise<void> {
    try {
      await api<{ ok: boolean }>(`${BASE}/history/log/${logId}/undo`, { method: 'POST' });
      await load();
      const r = await api<{ items: LogRow[] }>(`${BASE}/history/${batchId}`);
      setLogs((prev) => ({ ...prev, [batchId]: r.items ?? [] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'undo failed');
    }
  }

  const { paged: batchPaged, pagination: batchPagination } = useClientPage(batches);

  return (
    <Card title="Routing history">
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : batches.length === 0 ? (
        <EmptyState
          title="No batches yet"
          body="Committed routing batches appear here, with per-batch and per-file undo."
        />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
              fontFamily: tokens.font.body,
            }}
          >
            <thead>
              <tr style={{ background: tokens.color.surface }}>
                <th style={th('center')}>{''}</th>
                <th style={th()}>When</th>
                <th style={th('right')}>Total</th>
                <th style={th('right')}>Filed</th>
                <th style={th('right')}>K-1 copies</th>
                <th style={th('right')}>Reversed</th>
                <th style={th('right')}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {batchPaged.map((b) => {
                const open = expanded === b.batchId;
                const allReversed = b.total > 0 && b.reversed >= b.total;
                return (
                  <Fragment key={b.batchId}>
                    <tr style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                      <td style={{ ...td(), textAlign: 'center' }}>
                        <button
                          type="button"
                          aria-label={open ? 'Collapse' : 'Expand'}
                          onClick={() => void toggleExpand(b.batchId)}
                          style={iconBtn(false)}
                        >
                          {open ? '▾' : '▸'}
                        </button>
                      </td>
                      <td style={td()}>{new Date(b.at).toLocaleString()}</td>
                      <td style={{ ...td(), textAlign: 'right' }}>{b.total}</td>
                      <td style={{ ...td(), textAlign: 'right' }}>{b.filed}</td>
                      <td style={{ ...td(), textAlign: 'right' }}>{b.k1}</td>
                      <td style={{ ...td(), textAlign: 'right' }}>{b.reversed}</td>
                      <td style={{ ...td(), textAlign: 'right' }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={allReversed}
                          onClick={() => void undoBatch(b.batchId)}
                        >
                          Undo batch
                        </Button>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7} style={{ padding: 0 }}>
                          <BatchDetail
                            rows={logs[b.batchId]}
                            onUndoLog={(logId) => void undoLog(b.batchId, logId)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <PaginationBar {...batchPagination} />
        </div>
      )}
    </Card>
  );
}

const LOG_STATUS_TONE: Record<LogStatus, 'success' | 'warning' | 'danger'> = {
  success: 'success',
  reversed: 'warning',
  error: 'danger',
};

const LOG_ACTION_LABELS: Record<LogAction, string> = {
  filed: 'filed',
  tax_flagged: 'tax flagged',
  skipped: 'skipped',
  failed: 'failed',
  k1_recipient: 'K-1 recipient copy',
};

function BatchDetail({
  rows,
  onUndoLog,
}: {
  rows: LogRow[] | undefined;
  onUndoLog: (logId: string) => void;
}): JSX.Element {
  if (!rows) {
    return <div style={{ padding: 12, fontSize: 12, color: tokens.color.textMuted }}>Loading…</div>;
  }
  if (rows.length === 0) {
    return (
      <div style={{ padding: 12, fontSize: 12, color: tokens.color.textMuted }}>
        No file rows in this batch.
      </div>
    );
  }
  return (
    <div style={{ background: tokens.color.surface, padding: 12 }}>
      <ScrollX>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={th()}>From → To</th>
              <th style={th()}>Action</th>
              <th style={th()}>Status</th>
              <th style={th('right')}>Undo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                <td style={td()}>
                  <div
                    style={{ fontFamily: tokens.font.mono, fontSize: 11, wordBreak: 'break-all' }}
                  >
                    {r.objectKeyFrom}
                    {r.objectKeyTo && (
                      <>
                        {' → '}
                        {r.objectKeyTo}
                      </>
                    )}
                  </div>
                  {r.error && (
                    <div style={{ color: tokens.color.danger, fontSize: 11 }}>{r.error}</div>
                  )}
                </td>
                <td style={td()}>{LOG_ACTION_LABELS[r.action] ?? r.action}</td>
                <td style={td()}>
                  <Pill tone={LOG_STATUS_TONE[r.status]}>{r.status}</Pill>
                </td>
                <td style={{ ...td(), textAlign: 'right' }}>
                  {r.status === 'success' ? (
                    <Button size="sm" variant="ghost" onClick={() => onUndoLog(r.id)}>
                      Undo
                    </Button>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollX>
    </div>
  );
}
