// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// FMv2 — success toast on link/create completion. Auto-dismisses
// after 8 seconds; manually dismissable via the X.

import { useEffect, useState } from 'react';

import { tokens } from '@vibe/ui';

interface Props {
  storagePath: string;
  onDismiss: () => void;
}

export function IndexingToast({ storagePath, onDismiss }: Props): JSX.Element | null {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setVisible(false);
      onDismiss();
    }, 8000);
    return () => window.clearTimeout(id);
  }, [onDismiss]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.success}`,
        borderLeftWidth: 4,
        borderRadius: tokens.radius.sm,
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      }}
    >
      <span style={{ fontSize: 18 }} aria-hidden>
        ✅
      </span>
      <div style={{ flex: 1, fontSize: 13 }}>
        Linked to <code style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{storagePath}</code>.
        Indexing started — files will appear below as they&apos;re discovered.
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          setVisible(false);
          onDismiss();
        }}
        style={{
          background: 'transparent',
          border: 'none',
          fontSize: 18,
          cursor: 'pointer',
          color: tokens.color.textMuted,
          padding: 4,
        }}
      >
        ×
      </button>
    </div>
  );
}
