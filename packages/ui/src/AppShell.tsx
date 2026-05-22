// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type ReactNode } from 'react';

import { tokens } from './tokens';

export interface NavItem {
  label: string;
  href: string;
  active?: boolean;
  /** Optional glyph rendered in the collapsed icon rail. Defaults to the
   *  first letter of `label`. Pass a short symbol (1–2 chars) for best
   *  results — emoji and Unicode arrows render fine. */
  icon?: ReactNode;
}

export interface AppShellProps {
  brand: ReactNode;
  realmBadge?: ReactNode;
  nav: NavItem[];
  trailing?: ReactNode;
  children: ReactNode;
  /** localStorage key used to persist the collapsed/expanded state.
   *  Set per-realm so staff vs portal don't share preferences. */
  collapseStorageKey?: string;
}

const SIDEBAR_WIDTH_EXPANDED = 220;
const SIDEBAR_WIDTH_COLLAPSED = 56;
const DEFAULT_COLLAPSE_KEY = '__vibe_appshell_collapsed';

function readCollapsed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Storage may be disabled (incognito, etc.) — non-fatal.
  }
}

export function AppShell({
  brand,
  realmBadge,
  nav,
  trailing,
  children,
  collapseStorageKey = DEFAULT_COLLAPSE_KEY,
}: AppShellProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<boolean>(false);

  // Hydrate from localStorage on mount. SSR-safe — only touches storage
  // after the first render so the server-rendered HTML never depends on
  // a client-only value.
  useEffect(() => {
    setCollapsed(readCollapsed(collapseStorageKey));
  }, [collapseStorageKey]);

  const toggle = (): void => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(collapseStorageKey, next);
      return next;
    });
  };

  const sidebarWidth = collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.color.bg,
        color: tokens.color.text,
        fontFamily: tokens.font.body,
        display: 'flex',
        flexDirection: 'row',
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

      <aside
        aria-label="Sidebar"
        style={{
          width: sidebarWidth,
          minWidth: sidebarWidth,
          background: tokens.color.surface,
          borderRight: `1px solid ${tokens.color.border}`,
          display: 'flex',
          flexDirection: 'column',
          position: 'sticky',
          top: 0,
          height: '100vh',
          // Smooth width animation. Skip on prefers-reduced-motion via
          // CSS will require a media query; the 150ms ease is short
          // enough to be comfortable in either case.
          transition: 'width 150ms ease, min-width 150ms ease',
          overflowX: 'hidden',
        }}
      >
        {/* Brand row + collapse toggle */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space.sm,
            padding: `${tokens.space.md}px ${collapsed ? 12 : tokens.space.md}px`,
            borderBottom: `1px solid ${tokens.color.border}`,
            minHeight: 56,
          }}
        >
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              color: tokens.color.textMuted,
              fontSize: 16,
              lineHeight: 1,
              borderRadius: tokens.radius.sm,
            }}
          >
            {collapsed ? '▶' : '◀'}
          </button>
          {!collapsed && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <strong
                style={{
                  fontSize: 14,
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                }}
              >
                {brand}
              </strong>
              {realmBadge && <span>{realmBadge}</span>}
            </div>
          )}
        </div>

        {/* Nav links */}
        <nav
          aria-label="Primary"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            padding: `${tokens.space.sm}px ${collapsed ? 8 : tokens.space.sm}px`,
            flex: 1,
            overflowY: 'auto',
          }}
        >
          {nav.map((n) => {
            const glyph = n.icon ?? (typeof n.label === 'string' ? n.label.slice(0, 1) : '·');
            return (
              <a
                key={n.href}
                href={n.href}
                aria-current={n.active ? 'page' : undefined}
                title={collapsed ? n.label : undefined}
                style={{
                  color: n.active ? tokens.color.accent : tokens.color.text,
                  textDecoration: 'none',
                  fontSize: 13,
                  padding: collapsed ? '8px 0' : '8px 12px',
                  borderRadius: tokens.radius.sm,
                  background: n.active ? tokens.color.accentMuted : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 24,
                    minWidth: 24,
                    fontSize: 13,
                    fontWeight: n.active ? 600 : 500,
                    color: n.active ? tokens.color.accent : tokens.color.textMuted,
                  }}
                >
                  {glyph}
                </span>
                {!collapsed && (
                  <span style={{ textOverflow: 'ellipsis', overflow: 'hidden' }}>{n.label}</span>
                )}
              </a>
            );
          })}
        </nav>

        {/* Trailing — ThemeToggle / Sign out / etc. */}
        {trailing && (
          <div
            style={{
              padding: `${tokens.space.sm}px ${collapsed ? 8 : tokens.space.sm}px`,
              borderTop: `1px solid ${tokens.color.border}`,
              display: 'flex',
              flexDirection: collapsed ? 'column' : 'row',
              alignItems: 'center',
              justifyContent: collapsed ? 'center' : 'flex-start',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            {trailing}
          </div>
        )}
      </aside>

      <main
        id="main-content"
        style={{
          padding: tokens.space.xl,
          flex: 1,
          minWidth: 0, // allow inner overflow to scroll independently
        }}
        tabIndex={-1}
      >
        {children}
      </main>
    </div>
  );
}
