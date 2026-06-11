// SPDX-License-Identifier: Elastic-2.0
//
// Inline SVG sparkline (Phase 17 #25). Pure rendering — no axis,
// no labels, no tooltips. The container should provide its own title
// (e.g. "Realization · Q1 2026") and the value display.
//
// Renders a smooth polyline plus an optional area fill. Colors come from
// the theme tokens so light/dark mode swap correctly.

import { tokens } from './tokens';

export interface SparklineProps {
  /** Numeric series; empty or 1-element arrays render nothing. */
  values: number[];
  width?: number;
  height?: number;
  /** Stroke / fill tone. Defaults to accent. */
  tone?: 'accent' | 'success' | 'warning' | 'danger' | 'neutral';
  /** Optionally clamp the Y axis (e.g. [0, 1] for percentage series). */
  yMin?: number;
  yMax?: number;
  ariaLabel?: string;
}

const TONE_STROKE: Record<NonNullable<SparklineProps['tone']>, string> = {
  accent: tokens.color.accent,
  success: tokens.color.success,
  warning: tokens.color.warning,
  danger: tokens.color.danger,
  neutral: tokens.color.textMuted,
};

export function Sparkline({
  values,
  width = 80,
  height = 22,
  tone = 'accent',
  yMin,
  yMax,
  ariaLabel,
}: SparklineProps): JSX.Element | null {
  if (!values || values.length < 2) return null;

  const min = yMin ?? Math.min(...values);
  const max = yMax ?? Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const padY = 2;

  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = padY + (1 - (v - min) / range) * (height - 2 * padY);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const stroke = TONE_STROKE[tone];
  // Build the area-fill path: line + drop to baseline + close.
  const areaPath = `M ${values
    .map((v, i) => {
      const x = i * stepX;
      const y = padY + (1 - (v - min) / range) * (height - 2 * padY);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' L ')} L ${width.toFixed(2)},${height - padY} L 0,${height - padY} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel ?? 'sparkline'}
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      <path d={areaPath} fill={stroke} fillOpacity={0.15} stroke="none" />
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
