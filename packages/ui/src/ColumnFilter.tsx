// SPDX-License-Identifier: Elastic-2.0
//
// Column-header filter popover for table views (engagements list,
// future Files manager + Reports). Layout matches the Canopy reference:
//   Sort A-Z / Sort Z-A
//   [ search values ]
//   Uncheck all              Check all
//   [ ✓ option ]
//   [ ✓ option ]
//   …
//   [Apply]   Cancel   Clear

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { tokens } from './tokens';
import { usePopoverPosition } from './usePopoverPosition';

const POPOVER_MAX_HEIGHT = 400;

export type SortDir = 'asc' | 'desc' | null;

export interface ColumnFilterValue {
  value: string;
  label: string;
}

export interface ColumnFilterProps {
  /** Optional trigger label (defaults to ▾ icon). */
  trigger?: ReactNode;
  values: ColumnFilterValue[];
  selected: Set<string>;
  sort: SortDir;
  onApply: (selected: Set<string>, sort: SortDir) => void;
  onClear?: () => void;
  searchable?: boolean;
  ariaLabel?: string;
}

const buttonReset: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  font: 'inherit',
  color: 'inherit',
  padding: 0,
};

export function ColumnFilter({
  trigger,
  values,
  selected,
  sort,
  onApply,
  onClear,
  searchable = true,
  ariaLabel,
}: ColumnFilterProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draftSelected, setDraftSelected] = useState<Set<string>>(new Set(selected));
  const [draftSort, setDraftSort] = useState<SortDir>(sort);
  const [query, setQuery] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // QA fix — portal-rendered popover with viewport-aware positioning so
  // the popover isn't clipped by any scrolling ancestor (the table
  // wrapper around Engagements uses overflow-x:auto which traps inline
  // popovers).
  const popoverPos = usePopoverPosition({
    triggerRef,
    open,
    popoverMaxHeight: POPOVER_MAX_HEIGHT,
    minWidth: 260,
  });

  // QA fix — only sync draft state when the popover *opens*. Previously
  // `selected` and `sort` were in the deps, so any parent re-render that
  // produced a new Set reference (Engagements.tsx passes `new Set()`
  // literals for the sort-only columns) wiped the user's in-progress
  // selection. Use an open-edge detector via a ref.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setDraftSelected(new Set(selected));
      setDraftSort(sort);
      setQuery('');
    }
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: PointerEvent): void {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [open]);

  const filtered = useMemo(() => {
    if (!query) return values;
    const q = query.toLowerCase();
    return values.filter((v) => v.label.toLowerCase().includes(q));
  }, [values, query]);

  function toggle(v: string): void {
    const next = new Set(draftSelected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setDraftSelected(next);
  }

  function checkAll(): void {
    setDraftSelected(new Set(filtered.map((v) => v.value)));
  }
  function uncheckAll(): void {
    const next = new Set(draftSelected);
    for (const v of filtered) next.delete(v.value);
    setDraftSelected(next);
  }

  function apply(): void {
    onApply(draftSelected, draftSort);
    setOpen(false);
  }
  function cancel(): void {
    setOpen(false);
  }
  function clear(): void {
    setDraftSelected(new Set());
    setDraftSort(null);
    onClear?.();
    onApply(new Set(), null);
    setOpen(false);
  }

  const activeCount = selected.size + (sort ? 1 : 0);

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel ?? 'Filter and sort column'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          ...buttonReset,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          color: activeCount > 0 ? tokens.color.accent : tokens.color.textMuted,
          fontSize: 11,
        }}
      >
        {trigger ?? '▾'}
        {activeCount > 0 && (
          <span
            style={{
              fontSize: 9,
              padding: '0 4px',
              borderRadius: tokens.radius.pill,
              background: tokens.color.accentMuted,
              color: tokens.color.accent,
            }}
          >
            {activeCount}
          </span>
        )}
      </button>
      {open &&
        popoverPos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={ariaLabel ?? 'Column filter'}
            style={{
              position: 'fixed',
              zIndex: 9999,
              top: popoverPos.top,
              left: popoverPos.left,
              width: popoverPos.width,
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setDraftSort('asc');
              }}
              style={{
                ...buttonReset,
                textAlign: 'left',
                padding: '6px 8px',
                borderRadius: tokens.radius.sm,
                background: draftSort === 'asc' ? tokens.color.accentMuted : 'transparent',
                color: draftSort === 'asc' ? tokens.color.accent : tokens.color.text,
                fontSize: 13,
              }}
            >
              Sort <strong>A → Z</strong>
            </button>
            <button
              type="button"
              onClick={() => setDraftSort('desc')}
              style={{
                ...buttonReset,
                textAlign: 'left',
                padding: '6px 8px',
                borderRadius: tokens.radius.sm,
                background: draftSort === 'desc' ? tokens.color.accentMuted : 'transparent',
                color: draftSort === 'desc' ? tokens.color.accent : tokens.color.text,
                fontSize: 13,
              }}
            >
              Sort <strong>Z → A</strong>
            </button>

            {searchable && (
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search values"
                aria-label="Search values"
                style={{
                  marginTop: 4,
                  padding: '6px 8px',
                  background: tokens.color.bg,
                  color: tokens.color.text,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  fontSize: 13,
                  boxSizing: 'border-box',
                }}
              />
            )}

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                padding: '0 4px',
                fontSize: 11,
              }}
            >
              <button
                type="button"
                onClick={uncheckAll}
                style={{
                  ...buttonReset,
                  textDecoration: 'underline',
                  color: tokens.color.text,
                }}
              >
                Uncheck all
              </button>
              <button
                type="button"
                onClick={checkAll}
                style={{
                  ...buttonReset,
                  textDecoration: 'underline',
                  color: tokens.color.text,
                }}
              >
                Check all
              </button>
            </div>

            <div style={{ maxHeight: 180, overflowY: 'auto', display: 'grid', gap: 2 }}>
              {filtered.length === 0 ? (
                <p style={{ margin: 0, padding: 8, fontSize: 12, color: tokens.color.textMuted }}>
                  No matches
                </p>
              ) : (
                filtered.map((v) => {
                  const checked = draftSelected.has(v.value);
                  return (
                    <label
                      key={v.value}
                      htmlFor={`colf-${v.value}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 8px',
                        fontSize: 13,
                        cursor: 'pointer',
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      <input
                        id={`colf-${v.value}`}
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(v.value)}
                      />
                      {v.label}
                    </label>
                  );
                })
              )}
            </div>

            <div
              style={{
                display: 'flex',
                gap: 6,
                borderTop: `1px solid ${tokens.color.border}`,
                paddingTop: 6,
              }}
            >
              <button
                type="button"
                onClick={apply}
                style={{
                  padding: '6px 12px',
                  background: tokens.color.accent,
                  color: tokens.color.bg,
                  border: 'none',
                  borderRadius: tokens.radius.sm,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Apply
              </button>
              <button
                type="button"
                onClick={cancel}
                style={{
                  ...buttonReset,
                  padding: '6px 12px',
                  color: tokens.color.accent,
                  fontSize: 13,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={clear}
                style={{
                  ...buttonReset,
                  padding: '6px 12px',
                  color: tokens.color.accent,
                  fontSize: 13,
                  marginLeft: 'auto',
                }}
              >
                Clear
              </button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
