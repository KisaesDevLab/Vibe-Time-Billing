// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared modal shell — promoted from the ClientFilesTab's ad-hoc
// ModalShell so every dialog sits on one implementation with a single
// z-index scale (overlay 500). Escape and backdrop-click close when
// `onClose` is provided; pass undefined to lock the dialog open while
// an operation is running.
//
// M0 — on narrow viewports the dialog becomes a full-screen sheet:
// edge-to-edge, safe-area padding, a header row with a 44×44 close
// button and a scrollable body. `minWidth`/`maxWidth` are desktop
// bounds and are ignored on the sheet. The desktop branch is unchanged.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { CloseIcon } from './icons';
import { tokens } from './tokens';
import { useIsNarrow } from './useIsNarrow';

export interface ModalProps {
  title: string;
  onClose?: () => void;
  children: React.ReactNode;
  /** Width bounds — defaults suit form dialogs. Desktop only; the
   *  phone sheet is always full-screen. */
  minWidth?: number;
  maxWidth?: number;
}

export function Modal({
  title,
  onClose,
  children,
  minWidth = 420,
  maxWidth = 640,
}: ModalProps): JSX.Element {
  const narrow = useIsNarrow();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Move focus into the dialog on open so keyboard/screen-reader users
  // land inside it (and phone soft-keyboards don't type into the page).
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (panel.contains(document.activeElement)) return;
    panel.focus();
  }, []);

  if (narrow) {
    // Full-screen sheet. The body is zoom-clamped to 1 on phones, so
    // 100dvw/100dvh need no counter-division here; the sheet fills the
    // dynamic viewport (dvh tracks the iOS Safari collapsing toolbar).
    return createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 500,
          background: tokens.color.surface,
          display: 'flex',
          flexDirection: 'column',
          width: '100dvw',
          height: '100dvh',
          paddingTop: 'env(safe-area-inset-top, 0px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        <div
          ref={panelRef}
          tabIndex={-1}
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
            outline: 'none',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.space.sm,
              padding: `10px ${tokens.space.md}px`,
              borderBottom: `1px solid ${tokens.color.border}`,
              flexShrink: 0,
            }}
          >
            <h3
              style={{
                margin: 0,
                fontSize: 16,
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                overflow: 'hidden',
              }}
            >
              {title}
            </h3>
            {onClose && (
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  background: 'transparent',
                  border: 'none',
                  borderRadius: tokens.radius.sm,
                  color: tokens.color.textMuted,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <CloseIcon size={20} />
              </button>
            )}
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
              padding: tokens.space.md,
            }}
          >
            {children}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
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
        zIndex: 500,
        padding: 16,
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
        ref={panelRef}
        tabIndex={-1}
        style={{
          background: tokens.color.surface,
          borderRadius: tokens.radius.md,
          padding: 20,
          minWidth,
          maxWidth,
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          position: 'relative',
          zIndex: 1,
          outline: 'none',
        }}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>{title}</h3>
        {children}
      </div>
    </div>,
    document.body,
  );
}
