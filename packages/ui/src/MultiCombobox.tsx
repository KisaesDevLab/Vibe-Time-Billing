// SPDX-License-Identifier: Elastic-2.0
//
// Searchable multi-select dropdown. Same popover behavior as Combobox
// but the option list has checkboxes and the trigger shows chips for
// selected values (collapses to "+N more" past chipLimit).

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
import type { ComboboxOption } from './Combobox';
import { usePopoverPosition } from './usePopoverPosition';

const POPOVER_MAX_HEIGHT = 320;

export interface MultiComboboxProps {
  options: ComboboxOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  width?: number | string;
  filterFn?: (option: ComboboxOption, query: string) => boolean;
  renderOption?: (option: ComboboxOption, state: { highlighted: boolean }) => ReactNode;
  chipLimit?: number;
  ariaLabel?: string;
}

function defaultFilter(option: ComboboxOption, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (option.label.toLowerCase().includes(q)) return true;
  if (option.description && option.description.toLowerCase().includes(q)) return true;
  return false;
}

export function MultiCombobox({
  options,
  selected,
  onChange,
  placeholder = '— select —',
  emptyLabel = 'No matches',
  disabled,
  size = 'md',
  width,
  filterFn = defaultFilter,
  renderOption,
  chipLimit = 5,
  ariaLabel,
}: MultiComboboxProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  // QA fix — portal-rendered popover with viewport-aware positioning,
  // mirrors Combobox. Escapes overflow clipping from scrolling parents.
  const popoverPos = usePopoverPosition({
    triggerRef,
    open,
    popoverMaxHeight: POPOVER_MAX_HEIGHT,
  });

  const filtered = useMemo(
    () => options.filter((o) => filterFn(o, query)),
    [options, query, filterFn],
  );

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedLabels = options.filter((o) => selectedSet.has(o.value));

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

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

  const toggle = useCallback(
    (opt: ComboboxOption) => {
      if (opt.disabled) return;
      const next = new Set(selectedSet);
      if (next.has(opt.value)) next.delete(opt.value);
      else next.add(opt.value);
      onChange(Array.from(next));
    },
    [onChange, selectedSet],
  );

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[highlightIndex];
      if (opt) toggle(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
      triggerRef.current?.focus();
    }
  }

  const visibleChips = selectedLabels.slice(0, chipLimit);
  const overflow = selectedLabels.length - visibleChips.length;

  const triggerStyle: CSSProperties = {
    width: width ?? '100%',
    minHeight: size === 'sm' ? 30 : 36,
    padding: size === 'sm' ? '4px 8px' : '6px 8px',
    background: disabled ? tokens.color.bg : tokens.color.surface,
    color: disabled ? tokens.color.textMuted : tokens.color.text,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    fontSize: size === 'sm' ? 13 : 14,
    fontFamily: tokens.font.body,
    textAlign: 'left',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
    boxSizing: 'border-box',
  };

  // reason: see Combobox; identical keyboard-routing wrapper.
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
        {selectedLabels.length === 0 ? (
          <span style={{ color: tokens.color.textMuted, flex: 1 }}>{placeholder}</span>
        ) : (
          <>
            {visibleChips.map((opt) => (
              <span
                key={opt.value}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 6px',
                  borderRadius: tokens.radius.pill,
                  background: tokens.color.accentMuted,
                  color: tokens.color.accent,
                  fontSize: 11,
                }}
              >
                {opt.label}
                <span
                  role="button"
                  aria-label={`Remove ${opt.label}`}
                  tabIndex={-1}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    toggle(opt);
                  }}
                  style={{ cursor: 'pointer', fontSize: 12, lineHeight: 1 }}
                >
                  ×
                </span>
              </span>
            ))}
            {overflow > 0 && (
              <span style={{ fontSize: 11, color: tokens.color.textMuted }}>+{overflow} more</span>
            )}
          </>
        )}
        <span
          aria-hidden
          style={{
            marginLeft: 'auto',
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
            aria-multiselectable
            id={listboxId}
            tabIndex={-1}
            aria-activedescendant={
              filtered[highlightIndex] ? `${listboxId}-opt-${highlightIndex}` : undefined
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
            <div style={{ overflowY: 'auto', flex: 1 }}>
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
                filtered.map((opt, i) => {
                  const highlighted = i === highlightIndex;
                  const isSelected = selectedSet.has(opt.value);
                  return (
                    <div
                      key={opt.value}
                      id={`${listboxId}-opt-${i}`}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={opt.disabled}
                      onPointerEnter={() => setHighlightIndex(i)}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        toggle(opt);
                      }}
                      style={{
                        padding: '6px 10px',
                        cursor: opt.disabled ? 'not-allowed' : 'pointer',
                        background: highlighted ? tokens.color.accentMuted : 'transparent',
                        color: opt.disabled ? tokens.color.textMuted : tokens.color.text,
                        fontSize: 13,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        tabIndex={-1}
                        style={{ pointerEvents: 'none' }}
                      />
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
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
