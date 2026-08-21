// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared modal shell — promoted from the ClientFilesTab's ad-hoc
// ModalShell so every dialog sits on one implementation with a single
// z-index scale (overlay 500). Escape and backdrop-click close when
// `onClose` is provided; pass undefined to lock the dialog open while
// an operation is running.

import { useEffect } from 'react';
import { createPortal } from 'react-dom';

import { tokens } from './tokens';

export interface ModalProps {
  title: string;
  onClose?: () => void;
  children: React.ReactNode;
  /** Width bounds — defaults suit form dialogs. */
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
  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

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
        }}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>{title}</h3>
        {children}
      </div>
    </div>,
    document.body,
  );
}
