// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useCallback, useEffect, useState } from 'react';

import { tokens, THEME_STORAGE_KEY, type ThemeMode } from './tokens';

function readInitialTheme(): ThemeMode {
  if (typeof document === 'undefined') return 'dark';
  const attr = document.documentElement.dataset['theme'];
  if (attr === 'light' || attr === 'dark') return attr;
  return 'dark';
}

export function useTheme(): {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  toggle: () => void;
} {
  const [theme, setThemeState] = useState<ThemeMode>(readInitialTheme);

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t);
    if (typeof document !== 'undefined') {
      document.documentElement.dataset['theme'] = t;
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      // localStorage may be unavailable (private mode); the in-memory
      // state still drives the current session.
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  useEffect(() => {
    const current = readInitialTheme();
    if (current !== theme) setThemeState(current);
    // Cross-tab sync.
    function onStorage(e: StorageEvent): void {
      if (e.key !== THEME_STORAGE_KEY) return;
      const next = e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : 'dark';
      setThemeState(next);
      if (typeof document !== 'undefined') document.documentElement.dataset['theme'] = next;
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { theme, setTheme, toggle };
}

export interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps): JSX.Element {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      className={className}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: tokens.radius.sm,
        border: `1px solid ${tokens.color.border}`,
        background: tokens.color.surface,
        color: tokens.color.text,
        cursor: 'pointer',
        padding: 0,
        lineHeight: 1,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 14 }}>
        {isDark ? '☀' : '☾'}
      </span>
    </button>
  );
}
