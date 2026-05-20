// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import type { ReactNode } from 'react';

import { tokens } from './tokens';

export interface NavItem {
  label: string;
  href: string;
  active?: boolean;
}

export interface AppShellProps {
  brand: string;
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
        <nav style={{ display: 'flex', gap: tokens.space.md, marginLeft: tokens.space.xl }}>
          {nav.map((n) => (
            <a
              key={n.href}
              href={n.href}
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
      <main style={{ padding: tokens.space.xl, flex: 1 }}>{children}</main>
    </div>
  );
}
