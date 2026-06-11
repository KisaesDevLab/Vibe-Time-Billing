// SPDX-License-Identifier: Elastic-2.0
//
// CP0 — Empty state. UI plan §3 — centered icon-or-emoji + title +
// body + optional CTA. The default icon slot is intentionally empty so
// pages can pass an emoji ("📭") or a custom SVG without forcing an
// icon dependency in the UI package.

import type { CSSProperties, ReactNode } from 'react';

import { tokens } from './tokens';

export interface EmptyStateProps {
  /** Optional visual marker (emoji, SVG, or a small icon component). */
  icon?: ReactNode;
  title: ReactNode;
  /** Body copy explaining what's missing and what unblocks it. */
  body?: ReactNode;
  /** Optional CTA — a button or link element. */
  cta?: ReactNode;
  style?: CSSProperties;
}

export function EmptyState({ icon, title, body, cta, style }: EmptyStateProps): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        padding: `${tokens.space.xl}px ${tokens.space.lg}px`,
        color: tokens.color.textMuted,
        ...style,
      }}
    >
      {icon && <div style={{ fontSize: 32, marginBottom: tokens.space.sm }}>{icon}</div>}
      <div style={{ fontSize: 15, fontWeight: 600, color: tokens.color.text }}>{title}</div>
      {body && (
        <p style={{ margin: '8px 0 0', fontSize: 13, maxWidth: 440, lineHeight: 1.5 }}>{body}</p>
      )}
      {cta && <div style={{ marginTop: tokens.space.md }}>{cta}</div>}
    </div>
  );
}
