// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// M0 — drop-in replacement for `repeat(N, 1fr)` stat/form grids. Columns
// pack as many `min`-px tracks as fit and wrap naturally on phones;
// `min(minPx, 100%)` keeps a track from forcing horizontal overflow on
// screens narrower than minPx. Purely structural — no media queries.

import type { CSSProperties, ReactNode } from 'react';

export interface ResponsiveGridProps {
  children: ReactNode;
  /** Minimum column width in px before wrapping (default 220). */
  min?: number;
  /** Grid gap in px (default 16). */
  gap?: number;
  style?: CSSProperties;
}

export function ResponsiveGrid({
  children,
  min = 220,
  gap = 16,
  style,
}: ResponsiveGridProps): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`,
        gap,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
