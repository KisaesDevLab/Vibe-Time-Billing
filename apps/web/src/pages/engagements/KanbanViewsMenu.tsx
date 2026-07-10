// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Saved column-views dropdown for the engagements kanban. Each view is a
// per-user named set of visible status columns (CRUD via
// /api/staff/saved-kanban-views). The board still owns the working
// "hidden columns" set; this menu applies a view (sets that hidden set),
// and saves the current set as / into a named view. Last-used view id is
// remembered in localStorage so the board reopens on it.

import { useEffect, useRef, useState } from 'react';

import { Button, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface SavedView {
  id: string;
  name: string;
  boardType: string;
  visibleColumns: string[];
}

interface ColumnLike {
  workflowState: string;
}

const LAST_KEY = '__vibe_eng_kanban_view_id';

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}
function writeLast(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    // Non-fatal — in-memory state still drives the session.
  }
}

export function KanbanViewsMenu({
  columns,
  hidden,
  onApply,
}: {
  /** Firm status columns currently on the board (ordered). */
  columns: ColumnLike[];
  /** Working set of hidden workflow states. */
  hidden: Set<string>;
  /** Apply a view by handing the board a new hidden set. */
  onApply: (hidden: Set<string>) => void;
}): JSX.Element {
  const [views, setViews] = useState<SavedView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => readLast());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appliedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const visibleNow = (): string[] =>
    columns.filter((c) => !hidden.has(c.workflowState)).map((c) => c.workflowState);

  function hiddenForView(v: SavedView): Set<string> {
    const vis = new Set(v.visibleColumns);
    return new Set(columns.filter((c) => !vis.has(c.workflowState)).map((c) => c.workflowState));
  }

  async function loadViews(applyLast: boolean): Promise<void> {
    try {
      const r = await api<{ items: SavedView[] }>(
        '/api/staff/saved-kanban-views?boardType=engagement',
      );
      const items = r.items ?? [];
      setViews(items);
      if (applyLast && !appliedRef.current) {
        appliedRef.current = true;
        const v = items.find((x) => x.id === readLast());
        if (v) {
          setActiveId(v.id);
          onApply(hiddenForView(v));
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  // Load views once the board columns are known (needed to compute the
  // hidden set when re-applying the last-used view).
  useEffect(() => {
    if (columns.length === 0) return;
    void loadViews(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.length]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const active = views.find((v) => v.id === activeId) ?? null;

  // A view is "dirty" when the board's current visible set differs from
  // what the view stored (intersected with the columns that still exist).
  function isDirty(v: SavedView): boolean {
    const cur = new Set(visibleNow());
    const exp = new Set(
      v.visibleColumns.filter((ws) => columns.some((c) => c.workflowState === ws)),
    );
    if (cur.size !== exp.size) return true;
    for (const x of cur) if (!exp.has(x)) return true;
    return false;
  }
  const dirty = active ? isDirty(active) : false;

  function selectView(v: SavedView): void {
    setActiveId(v.id);
    writeLast(v.id);
    onApply(hiddenForView(v));
    setOpen(false);
  }

  function clearActive(): void {
    setActiveId(null);
    writeLast(null);
  }

  async function saveAsNew(): Promise<void> {
    const name = window.prompt('Name this view:')?.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ view: SavedView }>('/api/staff/saved-kanban-views', {
        method: 'POST',
        body: JSON.stringify({ name, boardType: 'engagement', visibleColumns: visibleNow() }),
      });
      await loadViews(false);
      if (r.view?.id) {
        setActiveId(r.view.id);
        writeLast(r.view.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  async function updateActive(): Promise<void> {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/saved-kanban-views/${active.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ visibleColumns: visibleNow() }),
      });
      await loadViews(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  async function rename(v: SavedView): Promise<void> {
    const name = window.prompt('Rename view:', v.name)?.trim();
    if (!name || name === v.name) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/saved-kanban-views/${v.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      await loadViews(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'rename_failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(v: SavedView): Promise<void> {
    if (!window.confirm(`Delete view “${v.name}”?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/saved-kanban-views/${v.id}`, { method: 'DELETE' });
      if (activeId === v.id) clearActive();
      await loadViews(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete_failed');
    } finally {
      setBusy(false);
    }
  }

  const itemBtn: React.CSSProperties = {
    background: 'none',
    border: 'none',
    fontSize: 11,
    color: tokens.color.accent,
    cursor: 'pointer',
    padding: 0,
  };

  return (
    <div style={{ position: 'relative' }} ref={menuRef}>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Saved column views"
      >
        ▦ {active ? `${active.name}${dirty ? ' •' : ''}` : 'Views'} ▾
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Saved views"
          style={{
            position: 'absolute',
            top: '110%',
            right: 0,
            minWidth: 260,
            background: tokens.color.bg,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            padding: 10,
            zIndex: 50,
            display: 'grid',
            gap: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              color: tokens.color.textMuted,
            }}
          >
            Saved views
          </p>

          {error && <p style={{ margin: 0, fontSize: 12, color: tokens.color.danger }}>{error}</p>}

          {views.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: tokens.color.textMuted }}>
              No saved views yet. Pick your columns with ⚙ Columns, then “Save current columns”.
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 2 }}>
              {views.map((v) => (
                <div
                  key={v.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 6px',
                    borderRadius: tokens.radius.sm,
                    background: v.id === activeId ? tokens.color.surface : 'transparent',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => selectView(v)}
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 13,
                      color: tokens.color.text,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    {v.id === activeId && <span style={{ color: tokens.color.accent }}>✓</span>}
                    {v.name}
                    <span style={{ color: tokens.color.textMuted, fontSize: 11 }}>
                      ({v.visibleColumns.length})
                    </span>
                  </button>
                  <button
                    type="button"
                    style={itemBtn}
                    disabled={busy}
                    onClick={() => void rename(v)}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    style={{ ...itemBtn, color: tokens.color.danger }}
                    disabled={busy}
                    onClick={() => void remove(v)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            style={{
              borderTop: `1px solid ${tokens.color.border}`,
              marginTop: 4,
              paddingTop: 6,
              display: 'grid',
              gap: 6,
            }}
          >
            {active && dirty && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Pill tone="warning">unsaved changes</Pill>
                <button
                  type="button"
                  style={itemBtn}
                  disabled={busy}
                  onClick={() => void updateActive()}
                >
                  Update “{active.name}”
                </button>
              </div>
            )}
            <button type="button" style={itemBtn} disabled={busy} onClick={() => void saveAsNew()}>
              ＋ Save current columns as new view…
            </button>
            {active && (
              <button type="button" style={itemBtn} onClick={clearActive}>
                Clear active view
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
