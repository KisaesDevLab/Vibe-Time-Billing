// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import type { CSSProperties, ReactNode } from 'react';

import { tokens } from './tokens';

export interface PillProps {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  children: ReactNode;
}

const TONE_COLORS: Record<NonNullable<PillProps['tone']>, string> = {
  neutral: tokens.color.textMuted,
  accent: tokens.color.accent,
  success: tokens.color.success,
  warning: tokens.color.warning,
  danger: tokens.color.danger,
};

export function Pill({ tone = 'neutral', children }: PillProps): JSX.Element {
  const color = TONE_COLORS[tone];
  const style: CSSProperties = {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: tokens.radius.pill,
    fontSize: 12,
    fontFamily: tokens.font.body,
    color,
    border: `1px solid ${color}`,
    background: 'transparent',
  };
  return <span style={style}>{children}</span>;
}
