// SPDX-License-Identifier: Elastic-2.0
import { useEffect, type ReactNode } from 'react';

import { tokens, THEME_STORAGE_KEY } from './tokens';

export interface AuthLayoutProps {
  brand: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Optional firm logo shown above the brand label (e.g. on the portal). */
  logo?: ReactNode;
}

/**
 * Sign-in / auth screens default to light. While an AuthLayout is mounted
 * the theme is forced light (this also covers the app-root → /auth
 * redirect, which doesn't re-run the index.html boot script); on leaving,
 * the authenticated app's default (system preference, dark fallback) is
 * restored. A user's explicit saved choice always wins — we no-op then.
 */
function useLightAuthTheme(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const read = (): string | null => {
      try {
        return localStorage.getItem(THEME_STORAGE_KEY);
      } catch {
        return null;
      }
    };
    if (read()) return undefined;
    document.documentElement.dataset.theme = 'light';
    return () => {
      const now = read();
      if (now) {
        document.documentElement.dataset.theme = now;
        return;
      }
      const prefersLight =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: light)').matches;
      document.documentElement.dataset.theme = prefersLight ? 'light' : 'dark';
    };
  }, []);
}

export function AuthLayout({
  brand,
  title,
  subtitle,
  children,
  footer,
  logo,
}: AuthLayoutProps): JSX.Element {
  useLightAuthTheme();
  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.color.bg,
        color: tokens.color.text,
        fontFamily: tokens.font.body,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.space.lg,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 380,
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space.xxl,
        }}
      >
        {logo && <div style={{ marginBottom: tokens.space.md }}>{logo}</div>}
        <div
          style={{
            fontSize: 12,
            color: tokens.color.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginBottom: tokens.space.sm,
          }}
        >
          {brand}
        </div>
        <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
        {subtitle && (
          <p style={{ color: tokens.color.textMuted, marginTop: 6, fontSize: 13 }}>{subtitle}</p>
        )}
        <div style={{ marginTop: tokens.space.xl }}>{children}</div>
        {footer && (
          <div
            style={{
              marginTop: tokens.space.xl,
              paddingTop: tokens.space.md,
              borderTop: `1px solid ${tokens.color.border}`,
              fontSize: 12,
              color: tokens.color.textMuted,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
