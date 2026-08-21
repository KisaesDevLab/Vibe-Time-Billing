// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Kebab / overflow menu — portal-rendered popover of actions, anchored
// to a trigger button. Consolidates rows that would otherwise sprout a
// strip of icon buttons. Follows ColumnFilter's portal + fixed
// positioning approach (usePopoverPosition) so the menu is never
// clipped by a scrolling table wrapper.
//
// Items follow the app convention for permissions: pass `disabled` +
// `disabledReason` so gated actions stay visible with an explanatory
// tooltip rather than vanishing.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { tokens } from './tokens';
import { usePopoverPosition } from './usePopoverPosition';

export interface MenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Tooltip shown when disabled (e.g. the missing permission). */
  disabledReason?: string;
  /** Renders in the danger color, below a divider. */
  danger?: boolean;
  /** Hide entirely (for items that never apply to this row). */
  hidden?: boolean;
}

export interface MenuProps {
  items: MenuItem[];
  /** Accessible name for the trigger; also its tooltip. */
  ariaLabel: string;
  /** Trigger content — defaults to a vertical-ellipsis glyph. */
  trigger?: React.ReactNode;
  disabled?: boolean;
}

const MENU_MAX_HEIGHT = 320;

export function Menu({ items, ariaLabel, trigger, disabled }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const pos = usePopoverPosition({
    triggerRef,
    open,
    popoverMaxHeight: MENU_MAX_HEIGHT,
    minWidth: 180,
  });

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: PointerEvent): void {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visible = items.filter((i) => !i.hidden);
  const normal = visible.filter((i) => !i.danger);
  const dangers = visible.filter((i) => i.danger);

  const itemStyle = (item: MenuItem): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '7px 12px',
    fontSize: 13,
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    color: item.disabled
      ? tokens.color.textMuted
      : item.danger
        ? tokens.color.danger
        : tokens.color.text,
    cursor: item.disabled ? 'not-allowed' : 'pointer',
    opacity: item.disabled ? 0.55 : 1,
  });

  const renderItem = (item: MenuItem): JSX.Element => (
    <button
      key={item.key}
      type="button"
      role="menuitem"
      disabled={item.disabled}
      title={item.disabled ? item.disabledReason : undefined}
      onClick={() => {
        if (item.disabled) return;
        setOpen(false);
        item.onSelect();
      }}
      onMouseEnter={(e) => {
        if (!item.disabled) e.currentTarget.style.background = tokens.color.accentMuted;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
      style={itemStyle(item)}
    >
      {item.icon && (
        <span style={{ display: 'inline-flex', width: 16, justifyContent: 'center' }}>
          {item.icon}
        </span>
      )}
      {item.label}
    </button>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          borderRadius: tokens.radius.sm,
          border: `1px solid ${tokens.color.border}`,
          background: open ? tokens.color.accentMuted : 'transparent',
          color: disabled ? tokens.color.textMuted : tokens.color.text,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          padding: 0,
          fontSize: 15,
          lineHeight: 1,
        }}
      >
        {trigger ?? '⋮'}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            role="menu"
            aria-label={ariaLabel}
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              minWidth: pos.width,
              maxHeight: MENU_MAX_HEIGHT,
              overflowY: 'auto',
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              padding: '4px 0',
              zIndex: 400,
            }}
          >
            {normal.map(renderItem)}
            {dangers.length > 0 && normal.length > 0 && (
              <div
                style={{ borderTop: `1px solid ${tokens.color.border}`, margin: '4px 0' }}
                role="separator"
              />
            )}
            {dangers.map(renderItem)}
          </div>,
          document.body,
        )}
    </>
  );
}
