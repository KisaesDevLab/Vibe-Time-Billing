// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Searchable single-select dropdown. Replaces native <select> wherever
// the option list is long enough that scroll-to-find is painful (clients,
// engagements, work codes, users, etc).
//
// Behavior summary:
//   - Click the trigger button to open a popover.
//   - Type to filter the list (case-insensitive substring on label +
//     description). The search input is auto-focused on open.
//   - Arrow keys move the highlight; Enter selects; Esc / outside click
//     closes without changing.
//   - Tab in opens. Tab out closes (committing nothing extra).
//   - Trigger shows the current label or placeholder; chevron on the
//     right rotates when open.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { tokens } from './tokens';
import { usePopoverPosition } from './usePopoverPosition';

const POPOVER_MAX_HEIGHT = 320;
// Render at most this many option rows at once — huge lists (thousands of
// clients) stall the popover; a hint row invites narrowing by typing.
const MAX_RENDERED = 200;

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  /** Currently advisory; kept on the interface for future native-form integration. */
  required?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  width?: number | string;
  filterFn?: (option: ComboboxOption, query: string) => boolean;
  renderOption?: (option: ComboboxOption, state: { highlighted: boolean }) => ReactNode;
  clearable?: boolean;
  ariaLabel?: string;
}

function defaultFilter(option: ComboboxOption, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (option.label.toLowerCase().includes(q)) return true;
  if (option.description && option.description.toLowerCase().includes(q)) return true;
  return false;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = '— select —',
  emptyLabel = 'No matches',
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  required: _required,
  disabled,
  size = 'md',
  width,
  filterFn = defaultFilter,
  renderOption,
  clearable = false,
  ariaLabel,
}: ComboboxProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  // QA fix — popover renders into document.body via a portal so it
  // escapes any ancestor's `overflow: auto/hidden` clipping (the
  // Engagements table wraps in overflowX:auto, which was truncating
  // the dropdown to ~1 visible option). Position recomputed on
  // scroll/resize.
  const popoverPos = usePopoverPosition({
    triggerRef,
    open,
    popoverMaxHeight: POPOVER_MAX_HEIGHT,
  });

  const filtered = useMemo(
    () => options.filter((o) => filterFn(o, query)),
    [options, query, filterFn],
  );
  // Cap the rendered rows — thousands of options would flood the DOM and
  // stall the popover; the hint row below the list tells the user to keep
  // typing. Filtering still runs over the full option set.
  const visible = useMemo(
    () => (filtered.length > MAX_RENDERED ? filtered.slice(0, MAX_RENDERED) : filtered),
    [filtered],
  );
  const hiddenCount = filtered.length - visible.length;

  const selectedOption = options.find((o) => o.value === value);

  // Reset highlight to selected option (or 0) when filter set changes.
  useEffect(() => {
    if (!open) return;
    const i = visible.findIndex((o) => o.value === value);
    setHighlightIndex(i >= 0 ? i : 0);
  }, [open, visible, value]);

  // Focus the search input on open.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Outside-click close.
  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: PointerEvent): void {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
      setQuery('');
    }
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [open]);

  const commit = useCallback(
    (next: ComboboxOption | null) => {
      if (next && !next.disabled) {
        onChange(next.value);
      }
      setOpen(false);
      setQuery('');
    },
    [onChange],
  );

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = visible[highlightIndex];
      if (opt) commit(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
      triggerRef.current?.focus();
    } else if (e.key === 'Tab') {
      // Let the browser handle Tab; close without committing extra.
      setOpen(false);
      setQuery('');
    }
  }

  // Padding mirrors <Input> (10px/12px at md, 6px/10px at sm) so a
  // Combobox sitting next to a text input lines up at the same height.
  // Prior values (8px/10px md) produced a 4px shorter trigger which was
  // visually inconsistent inside grid layouts that mix the two.
  const triggerStyle: CSSProperties = {
    width: width ?? '100%',
    padding: size === 'sm' ? '6px 10px' : '10px 12px',
    background: disabled ? tokens.color.bg : tokens.color.surface,
    color: disabled
      ? tokens.color.textMuted
      : selectedOption
        ? tokens.color.text
        : tokens.color.textMuted,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    fontSize: size === 'sm' ? 13 : 14,
    fontFamily: tokens.font.body,
    lineHeight: 1.4,
    textAlign: 'left',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    boxSizing: 'border-box',
  };

  // reason: This wrapper needs onKeyDown so arrow/Enter/Escape work whether
  // focus is on the trigger button or the search input inside the popover.
  // It's not itself interactive — the inner button and input are.
  return (
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions */
    <div style={{ position: 'relative', width: width ?? '100%' }} onKeyDown={onKey}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
        style={triggerStyle}
      >
        <span
          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        {clearable && selectedOption && !disabled && (
          <button
            type="button"
            aria-label="Clear"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onChange('');
            }}
            style={{
              border: 'none',
              background: 'transparent',
              color: tokens.color.textMuted,
              cursor: 'pointer',
              padding: 0,
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
        <span
          aria-hidden
          style={{
            color: tokens.color.textMuted,
            fontSize: 10,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 120ms',
          }}
        >
          ▾
        </span>
      </button>
      {open &&
        popoverPos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            role="listbox"
            id={listboxId}
            tabIndex={-1}
            aria-activedescendant={
              visible[highlightIndex] ? `${listboxId}-opt-${highlightIndex}` : undefined
            }
            onKeyDown={onKey}
            style={{
              position: 'fixed',
              zIndex: 9999,
              top: popoverPos.top,
              left: popoverPos.left,
              width: popoverPos.width,
              boxSizing: 'border-box',
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
              maxHeight: POPOVER_MAX_HEIGHT,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: 6, borderBottom: `1px solid ${tokens.color.border}` }}>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                aria-label="Filter options"
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  background: tokens.color.bg,
                  color: tokens.color.text,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  fontSize: 13,
                  fontFamily: tokens.font.body,
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ overflowY: 'auto', flex: 1, overscrollBehavior: 'contain' }}>
              {filtered.length === 0 ? (
                <p
                  style={{
                    margin: 0,
                    padding: 12,
                    fontSize: 12,
                    color: tokens.color.textMuted,
                    textAlign: 'center',
                  }}
                >
                  {emptyLabel}
                </p>
              ) : (
                visible.map((opt, i) => {
                  const highlighted = i === highlightIndex;
                  const isSelected = opt.value === value;
                  return (
                    // Keyboard interaction lives on the listbox (arrow keys +
                    // Enter via onKey and aria-activedescendant) — the ARIA
                    // listbox pattern where options are not individually
                    // focusable, so the per-option a11y rules don't apply.
                    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus
                    <div
                      key={opt.value}
                      id={`${listboxId}-opt-${i}`}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={opt.disabled}
                      onPointerEnter={() => setHighlightIndex(i)}
                      // Commit on click, not pointerdown: pointerdown fires
                      // the instant a finger lands, so preventDefault+commit
                      // there killed touch scrolling — on iPad the list
                      // couldn't scroll and grazing a row selected it. For
                      // mouse we still preventDefault on pointerdown so the
                      // filter input keeps focus; click follows and commits.
                      // A touch that turns into a scroll never emits click.
                      onPointerDown={(e) => {
                        if (e.pointerType === 'mouse') e.preventDefault();
                      }}
                      onClick={() => commit(opt)}
                      style={{
                        padding: '6px 10px',
                        cursor: opt.disabled ? 'not-allowed' : 'pointer',
                        background: highlighted ? tokens.color.accentMuted : 'transparent',
                        color: opt.disabled
                          ? tokens.color.textMuted
                          : highlighted
                            ? tokens.color.accent
                            : tokens.color.text,
                        fontSize: 13,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      {renderOption ? (
                        renderOption(opt, { highlighted })
                      ) : (
                        <>
                          <span style={{ flex: 1 }}>{opt.label}</span>
                          {opt.description && (
                            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                              {opt.description}
                            </span>
                          )}
                          {isSelected && (
                            <span aria-hidden style={{ color: tokens.color.accent }}>
                              ✓
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  );
                })
              )}
              {hiddenCount > 0 && (
                <p
                  style={{
                    margin: 0,
                    padding: '6px 10px',
                    fontSize: 11,
                    color: tokens.color.textMuted,
                  }}
                >
                  …{hiddenCount} more — keep typing to narrow
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
