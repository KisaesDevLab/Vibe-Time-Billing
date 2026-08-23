// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Simple tab bar. Caller owns the active key + onChange. Each Tab has a
// label and an optional badge. The component does not render the
// tab's content — callers conditionally render based on the active key.

import type { ReactNode } from 'react';

import { tokens } from './tokens';

export interface TabSpec {
  key: string;
  label: ReactNode;
  badge?: ReactNode;
}

export interface TabsProps {
  tabs: TabSpec[];
  active: string;
  onChange: (key: string) => void;
}

export function Tabs({ tabs, active, onChange }: TabsProps): JSX.Element {
  return (
    // role="tablist" applies to a div (or similar non-landmark container)
    // per WAI-ARIA — using <nav> conflicts with the tab pattern.
    <div
      role="tablist"
      className="vibe-tabs"
      style={{
        display: 'flex',
        gap: 0,
        borderBottom: `1px solid ${tokens.color.border}`,
        marginBottom: tokens.space.lg,
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        maxWidth: '100%',
      }}
    >
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.key)}
            style={{
              padding: '10px 16px',
              background: 'transparent',
              border: 'none',
              flexShrink: 0,
              whiteSpace: 'nowrap',
              borderBottom: `2px solid ${isActive ? tokens.color.accent : 'transparent'}`,
              color: isActive ? tokens.color.accent : tokens.color.text,
              fontSize: 14,
              fontWeight: isActive ? 600 : 400,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {t.label}
            {t.badge != null && (
              <span
                style={{
                  fontSize: 11,
                  padding: '1px 6px',
                  borderRadius: tokens.radius.pill,
                  background: isActive ? tokens.color.accentMuted : tokens.color.surface,
                  border: `1px solid ${tokens.color.border}`,
                  color: tokens.color.textMuted,
                }}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
