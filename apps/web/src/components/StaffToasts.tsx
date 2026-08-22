// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-2 — lightweight in-app toast stack for staff event notifications.
// Used in the browser, and in the desktop shell while the main window is
// focused (unfocused → native OS toast instead). Click navigates to the
// event's href; toasts auto-dismiss after 8 s.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { tokens } from '@vibe/ui';

export interface ToastItem {
  id: string;
  title: string;
  body?: string | null;
  href?: string | null;
  tone?: 'default' | 'accent' | 'warn';
}

const EVENT = 'vibe:toast';

/** Fire-and-forget from anywhere (no React context needed). */
export function pushToast(t: ToastItem): void {
  window.dispatchEvent(new CustomEvent<ToastItem>(EVENT, { detail: t }));
}

export function StaffToasts(): JSX.Element | null {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const navigate = useNavigate();

  const dismiss = useCallback((id: string) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  useEffect(() => {
    const onToast = (e: Event): void => {
      const t = (e as CustomEvent<ToastItem>).detail;
      setItems((xs) => [...xs.filter((x) => x.id !== t.id), t].slice(-4));
      const h = setTimeout(() => dismiss(t.id), 8000);
      timers.current.set(t.id, h);
    };
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, [dismiss]);

  if (items.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 1000,
        display: 'grid',
        gap: 8,
        width: 340,
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      {items.map((t) => (
        <div
          key={t.id}
          role={t.href ? 'button' : undefined}
          tabIndex={t.href ? 0 : undefined}
          onClick={() => {
            if (t.href && !t.href.includes('://')) navigate(t.href);
            dismiss(t.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (t.href && !t.href.includes('://')) navigate(t.href);
              dismiss(t.id);
            }
          }}
          style={{
            cursor: t.href ? 'pointer' : 'default',
            background: tokens.color.surface,
            color: tokens.color.text,
            border: `1px solid ${t.tone === 'warn' ? tokens.color.warning : tokens.color.border}`,
            borderLeft: `4px solid ${
              t.tone === 'warn'
                ? tokens.color.warning
                : t.tone === 'accent'
                  ? tokens.color.accent
                  : tokens.color.border
            }`,
            borderRadius: 8,
            padding: '10px 12px',
            boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
            fontFamily: tokens.font.body,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <strong style={{ fontSize: 13 }}>{t.title}</strong>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
              }}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.color.textMuted,
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
          {t.body && (
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 4 }}>
              {t.body}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
