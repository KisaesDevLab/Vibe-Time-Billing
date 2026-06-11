// SPDX-License-Identifier: Elastic-2.0
//
// A−/A+ font-size control. Mirrors the ThemeToggle pattern: persists
// the user's choice in localStorage, applies via `body { zoom: N }`
// which scales every descendant uniformly (works regardless of whether
// the design system uses px or rem). Defaults to 1.0.
//
// Discrete step model — four sizes (90%, 100%, 115%, 130%) — matches
// the accessibility controls in QuickBooks / Xero / MyBooks. A−
// steps down, A+ steps up; endpoints disable.

import { useCallback, useEffect, useState } from 'react';

import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_BASELINE,
  FONT_SCALE_STEPS,
  FONT_SCALE_STORAGE_KEY,
  tokens,
  type FontScale,
} from './tokens';

function readInitialScale(): FontScale {
  if (typeof window === 'undefined') return DEFAULT_FONT_SCALE;
  try {
    const raw = window.localStorage.getItem(FONT_SCALE_STORAGE_KEY);
    const n = raw ? Number.parseFloat(raw) : DEFAULT_FONT_SCALE;
    return (FONT_SCALE_STEPS as readonly number[]).includes(n)
      ? (n as FontScale)
      : DEFAULT_FONT_SCALE;
  } catch {
    return DEFAULT_FONT_SCALE;
  }
}

function applyScale(scale: FontScale): void {
  if (typeof document === 'undefined') return;
  // `body { zoom: N }` is supported across Chrome / Safari / Firefox
  // (FF 126+). Cleaner than a transform scale because it preserves
  // layout boxes and event coordinates.
  // Cast to a tolerant type because TS's lib.dom doesn't model `zoom`.
  (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(scale);
  document.documentElement.style.setProperty('--vibe-font-scale', String(scale));
}

export function useFontScale(): {
  scale: FontScale;
  setScale: (n: FontScale) => void;
  step: (direction: -1 | 1) => void;
} {
  const [scale, setScaleState] = useState<FontScale>(readInitialScale);

  const setScale = useCallback((n: FontScale) => {
    setScaleState(n);
    applyScale(n);
    try {
      window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(n));
    } catch {
      // Storage may be disabled — in-memory state still drives the
      // current session.
    }
  }, []);

  const step = useCallback(
    (direction: -1 | 1) => {
      const idx = FONT_SCALE_STEPS.indexOf(scale);
      const nextIdx = Math.max(0, Math.min(FONT_SCALE_STEPS.length - 1, idx + direction));
      const next = FONT_SCALE_STEPS[nextIdx];
      if (next !== undefined && next !== scale) setScale(next);
    },
    [scale, setScale],
  );

  useEffect(() => {
    // Make sure the initial paint matches storage (the bootstrap script
    // already does this; we re-apply here for React-only callers).
    applyScale(scale);
    function onStorage(e: StorageEvent): void {
      if (e.key !== FONT_SCALE_STORAGE_KEY) return;
      const next = e.newValue ? Number.parseFloat(e.newValue) : DEFAULT_FONT_SCALE;
      const safe = (FONT_SCALE_STEPS as readonly number[]).includes(next)
        ? (next as FontScale)
        : DEFAULT_FONT_SCALE;
      setScaleState(safe);
      applyScale(safe);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { scale, setScale, step };
}

export interface FontSizeControlProps {
  className?: string;
}

export function FontSizeControl({ className }: FontSizeControlProps): JSX.Element {
  const { scale, step } = useFontScale();
  const idx = FONT_SCALE_STEPS.indexOf(scale);
  const atMin = idx <= 0;
  const atMax = idx >= FONT_SCALE_STEPS.length - 1;
  // Percent label is relative to the re-anchored baseline so the
  // user sees 85 / 100 / 115 / 130 even though the underlying zoom
  // values are 0.98 / 1.15 / 1.32 / 1.5.
  const percent = Math.round((scale / FONT_SCALE_BASELINE) * 100);

  return (
    <div
      className={className}
      role="group"
      aria-label="Font size"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.surface,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={atMin}
        aria-label="Decrease font size"
        title={`Decrease font size (currently ${percent}%)`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 32,
          border: 'none',
          background: 'transparent',
          color: atMin ? tokens.color.textMuted : tokens.color.text,
          cursor: atMin ? 'not-allowed' : 'pointer',
          fontSize: 12,
          fontFamily: tokens.font.body,
          lineHeight: 1,
          padding: 0,
          opacity: atMin ? 0.5 : 1,
        }}
      >
        A−
      </button>
      <span
        aria-live="polite"
        style={{
          fontSize: 11,
          color: tokens.color.textMuted,
          padding: '0 6px',
          minWidth: 36,
          textAlign: 'center',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {percent}%
      </span>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={atMax}
        aria-label="Increase font size"
        title={`Increase font size (currently ${percent}%)`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 32,
          border: 'none',
          background: 'transparent',
          color: atMax ? tokens.color.textMuted : tokens.color.text,
          cursor: atMax ? 'not-allowed' : 'pointer',
          fontSize: 14,
          fontFamily: tokens.font.body,
          lineHeight: 1,
          padding: 0,
          opacity: atMax ? 0.5 : 1,
        }}
      >
        A+
      </button>
    </div>
  );
}
