// SPDX-License-Identifier: Elastic-2.0
import { Fragment, useEffect, useState, type ReactNode } from 'react';

import { ChevronRight } from './icons';
import { tokens } from './tokens';

export interface NavItem {
  label: string;
  href: string;
  active?: boolean;
  /** Optional glyph rendered in the collapsed icon rail. Defaults to the
   *  first letter of `label`. Pass a short symbol (1–2 chars) for best
   *  results — emoji and Unicode arrows render fine. */
  icon?: ReactNode;
  /** Optional section grouping. When an item's `section` differs from the
   *  previous item's, a separator is rendered before it: an uppercase
   *  header for a non-empty string, or a plain divider for an empty
   *  string (use '' to fence off a trailing utility group). Items with no
   *  `section` continue the current group with no separator. */
  section?: string;
  /** When true, the item gets an orange (warning-tone) background to signal
   *  unread/new items in that area — matching the High-priority tone. */
  hasUnread?: boolean;
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
  /** When true, non-empty `section` groups become collapsible accordions:
   *  the section header gets a chevron and toggles its items. Groups start
   *  collapsed; the section that contains the active item auto-opens until
   *  the user explicitly toggles it. Headerless groups (`section` === ''
   *  or undefined) are always shown. Per-section state is persisted under
   *  `${collapseStorageKey}__sections`. Ignored while the sidebar is in
   *  icon-rail mode (everything shows so the rail stays navigable). */
  collapsibleSections?: boolean;
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

const SECTION_KEY_SUFFIX = '__sections';

function readSections(key: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeSections(key: string, value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
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
  collapsibleSections = false,
}: AppShellProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const sectionStorageKey = collapseStorageKey + SECTION_KEY_SUFFIX;

  // Hydrate from localStorage on mount. SSR-safe — only touches storage
  // after the first render so the server-rendered HTML never depends on
  // a client-only value.
  useEffect(() => {
    setCollapsed(readCollapsed(collapseStorageKey));
  }, [collapseStorageKey]);

  useEffect(() => {
    setExpandedSections(readSections(sectionStorageKey));
  }, [sectionStorageKey]);

  // Auto-collapse to the icon rail on phones/narrow viewports so the
  // sidebar doesn't eat the screen. The user can still expand it; this only
  // sets the default when the viewport is (or becomes) narrow.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 720px)');
    const apply = (matches: boolean): void => {
      if (matches) setCollapsed(true);
    };
    apply(mq.matches);
    const handler = (e: MediaQueryListEvent): void => apply(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggle = (): void => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(collapseStorageKey, next);
      return next;
    });
  };

  const sidebarWidth = collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

  // Accordion sections only apply when enabled AND the sidebar is expanded
  // (the icon rail has no room for headers, so it shows every item).
  const accordion = collapsibleSections && !collapsed;
  // The section holding the active route auto-opens until the user toggles
  // it, so you can always see where you are without hunting.
  const activeSection = nav.find((n) => n.active)?.section;
  const isSectionExpanded = (section: string): boolean => {
    const explicit = expandedSections[section];
    return explicit !== undefined ? explicit : section === activeSection;
  };
  const toggleSection = (section: string): void => {
    setExpandedSections((prev) => {
      const current = prev[section] !== undefined ? prev[section]! : section === activeSection;
      const next = { ...prev, [section]: !current };
      writeSections(sectionStorageKey, next);
      return next;
    });
  };

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
          // FontSizeControl applies `body { zoom: N }`, which scales every
          // descendant uniformly. Viewport units inside a zoomed parent
          // still refer to the real viewport, so a naive `height: 100vh`
          // renders at `N × 100vh` on screen and overflows. Counter-
          // divide by the same var so the sidebar always equals one
          // actual screen-height regardless of zoom. Falls back to 100vh
          // when the var is unset (zoom = 1).
          height: 'calc(100vh / var(--vibe-font-scale, 1))',
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
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              color: tokens.color.textMuted,
              lineHeight: 1,
              borderRadius: tokens.radius.sm,
            }}
          >
            {/* Chevron points right to expand (collapsed) and left to collapse
                (expanded); reuses the line-icon family via a CSS rotation. */}
            <span
              aria-hidden
              style={{
                display: 'inline-flex',
                transition: 'transform 120ms ease',
                transform: collapsed ? 'none' : 'rotate(180deg)',
              }}
            >
              <ChevronRight size={16} />
            </span>
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
          {nav.map((n, i) => {
            const glyph = n.icon ?? (typeof n.label === 'string' ? n.label.slice(0, 1) : '·');
            // Section separator: render when this item's section differs
            // from the previous item's. A non-empty section shows an
            // uppercase header (a thin rule when collapsed); an empty
            // string shows just a rule. Undefined continues the group.
            const prevSection = i > 0 ? nav[i - 1]!.section : undefined;
            const showSeparator = n.section !== undefined && n.section !== prevSection;
            const isNamedSection = typeof n.section === 'string' && n.section !== '';
            const expanded = isNamedSection ? isSectionExpanded(n.section!) : true;
            // In accordion mode, items under a collapsed named section are
            // hidden; the header still renders so the group can be reopened.
            const hidden = accordion && isNamedSection && !expanded;
            let separator: ReactNode = null;
            if (showSeparator) {
              if (accordion && isNamedSection) {
                separator = (
                  <button
                    type="button"
                    onClick={() => toggleSection(n.section!)}
                    aria-expanded={expanded}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: 0.6,
                      textTransform: 'uppercase',
                      color: tokens.color.textMuted,
                      padding: `${i === 0 ? 4 : 12}px 12px 4px`,
                      borderRadius: tokens.radius.sm,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        transition: 'transform 120ms ease',
                        transform: expanded ? 'rotate(90deg)' : 'none',
                      }}
                    >
                      <ChevronRight size={13} />
                    </span>
                    {n.section}
                  </button>
                );
              } else if (collapsed || n.section === '') {
                separator = (
                  <div
                    aria-hidden
                    style={{
                      height: 1,
                      background: tokens.color.border,
                      margin: `${i === 0 ? 0 : 8}px ${collapsed ? 4 : 8}px 6px`,
                    }}
                  />
                );
              } else {
                separator = (
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: 0.6,
                      textTransform: 'uppercase',
                      color: tokens.color.textMuted,
                      padding: '12px 12px 4px',
                    }}
                  >
                    {n.section}
                  </div>
                );
              }
            }
            return (
              <Fragment key={n.href}>
                {separator}
                {!hidden && (
                  <a
                    href={n.href}
                    aria-current={n.active ? 'page' : undefined}
                    title={collapsed ? n.label : undefined}
                    style={{
                      color: n.active ? tokens.color.accent : tokens.color.text,
                      textDecoration: 'none',
                      fontSize: 13,
                      padding: collapsed ? '8px 0' : '8px 12px',
                      borderRadius: tokens.radius.sm,
                      // Active wins; otherwise an unread area gets an orange
                      // (warning-tone) tint matching the High-priority signal.
                      background: n.active
                        ? tokens.color.accentMuted
                        : n.hasUnread
                          ? 'color-mix(in srgb, var(--vibe-color-warning) 26%, transparent)'
                          : 'transparent',
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
                      <span style={{ textOverflow: 'ellipsis', overflow: 'hidden' }}>
                        {n.label}
                      </span>
                    )}
                  </a>
                )}
              </Fragment>
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
