// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import type { ReactNode } from 'react';

import { tokens } from './tokens';

export interface NavItem {
  label: string;
  href: string;
  active?: boolean;
}

export interface AppShellProps {
  brand: ReactNode;
  realmBadge?: ReactNode;
  nav: NavItem[];
  trailing?: ReactNode;
  children: ReactNode;
}

export function AppShell({
  brand,
  realmBadge,
  nav,
  trailing,
  children,
}: AppShellProps): JSX.Element {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.color.bg,
        color: tokens.color.text,
        fontFamily: tokens.font.body,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Skip link — visible only on keyboard focus. Lets keyboard /
          screen-reader users jump past the nav to main content. */}
      <a
        href="#main-content"
        style={{
          position: 'absolute',
          left: -10000,
          top: 'auto',
          width: 1,
          height: 1,
          overflow: 'hidden',
        }}
        onFocus={(e) => {
          const el = e.currentTarget;
          el.style.left = '8px';
          el.style.top = '8px';
          el.style.width = 'auto';
          el.style.height = 'auto';
          el.style.padding = '8px 12px';
          el.style.background = tokens.color.surface;
          el.style.color = tokens.color.text;
          el.style.border = `2px solid ${tokens.color.accent}`;
          el.style.borderRadius = `${tokens.radius.sm}px`;
          el.style.zIndex = '1000';
        }}
        onBlur={(e) => {
          const el = e.currentTarget;
          el.style.left = '-10000px';
          el.style.width = '1px';
          el.style.height = '1px';
          el.style.padding = '0';
        }}
      >
        Skip to main content
      </a>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.space.lg,
          padding: `${tokens.space.md}px ${tokens.space.xl}px`,
          borderBottom: `1px solid ${tokens.color.border}`,
          background: tokens.color.surface,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
          <strong style={{ fontSize: 16 }}>{brand}</strong>
          {realmBadge}
        </div>
        <nav
          aria-label="Primary"
          style={{ display: 'flex', gap: tokens.space.md, marginLeft: tokens.space.xl }}
        >
          {nav.map((n) => (
            <a
              key={n.href}
              href={n.href}
              aria-current={n.active ? 'page' : undefined}
              style={{
                color: n.active ? tokens.color.accent : tokens.color.textMuted,
                textDecoration: 'none',
                fontSize: 13,
                padding: `4px 8px`,
                borderRadius: tokens.radius.sm,
                background: n.active ? tokens.color.accentMuted : 'transparent',
              }}
            >
              {n.label}
            </a>
          ))}
        </nav>
        <div style={{ marginLeft: 'auto' }}>{trailing}</div>
      </header>
      <main id="main-content" style={{ padding: tokens.space.xl, flex: 1 }} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
