// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP0 — Narrow-viewport detection. Pages that want a mobile card-list
// fallback for their Table use this hook to pick the render path.
// Server-rendered defaults to false (wide) so SSR markup matches the
// desktop layout; the client effect flips on hydration.

import { useEffect, useState } from 'react';

const DEFAULT_BREAKPOINT_PX = 720;

export function useIsNarrow(breakpointPx: number = DEFAULT_BREAKPOINT_PX): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    setNarrow(mq.matches);
    const handler = (e: MediaQueryListEvent): void => setNarrow(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpointPx]);
  return narrow;
}
