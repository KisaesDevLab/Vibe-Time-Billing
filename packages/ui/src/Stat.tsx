// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP0 — Stat primitive. Replaces the inline Stat components that the
// retainer dashboards (RetainerDashboard.tsx, StaffRetainerDashboard.tsx)
// duplicated. The shape matches the UI plan §2 typography scale: a
// small uppercase label above a large tabular-numeric value, with an
// optional tone hint for KPI severity (e.g. red on overdue counts).

import type { CSSProperties, ReactNode } from 'react';

import { tokens } from './tokens';

export type StatTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  /** Tone applied to the big value text. Defaults to plain text. */
  tone?: StatTone;
  /** Optional small caption under the value (e.g. "+3 since last week"). */
  caption?: ReactNode;
  style?: CSSProperties;
}

const TONE_COLOR: Record<StatTone, string> = {
  neutral: tokens.color.text,
  success: tokens.color.success,
  warning: tokens.color.warning,
  danger: tokens.color.danger,
  accent: tokens.color.accent,
};

export function Stat({ label, value, tone = 'neutral', caption, style }: StatProps): JSX.Element {
  return (
    <div
      style={{
        padding: tokens.space.md,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.surface,
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: tokens.color.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          marginTop: 4,
          color: TONE_COLOR[tone],
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      {caption && (
        <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 2 }}>{caption}</div>
      )}
    </div>
  );
}
