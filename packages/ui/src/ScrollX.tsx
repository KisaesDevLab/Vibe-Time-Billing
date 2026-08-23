// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// M0 — horizontal scroll container for content that is intrinsically
// wide (month calendars, heatmaps, letter-size previews, raw <table>s).
// Keeps the overflow inside the wrapper so the PAGE never scrolls
// sideways on phones. Desktop is unaffected when the content fits.

import type { CSSProperties, ReactNode } from 'react';

export interface ScrollXProps {
  children: ReactNode;
  style?: CSSProperties;
}

export function ScrollX({ children, style }: ScrollXProps): JSX.Element {
  return (
    <div
      style={{
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        maxWidth: '100%',
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
