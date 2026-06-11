// SPDX-License-Identifier: Elastic-2.0
//
// FMv2 — confidence bar (4px height) with percentage label.

import { tokens } from '@vibe/ui';

export function ConfidenceBar({ confidence }: { confidence: number }): JSX.Element {
  const pct = Math.round(confidence * 100);
  // Color scale: high (info) → mid (warn) → low (muted).
  const color =
    confidence >= 0.85
      ? tokens.color.accent
      : confidence >= 0.65
        ? tokens.color.warning
        : tokens.color.textMuted;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        aria-label={`Confidence ${pct}%`}
        style={{
          flex: 1,
          height: 4,
          background: tokens.color.border,
          borderRadius: 2,
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: `${pct}%`,
            background: color,
            borderRadius: 2,
          }}
        />
      </div>
      <span
        style={{
          fontSize: 12,
          color: tokens.color.textMuted,
          fontVariantNumeric: 'tabular-nums',
          minWidth: 40,
          textAlign: 'right',
        }}
      >
        {pct}%
      </span>
    </div>
  );
}
