// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP0 / M0 — narrow-viewport detection, shared by AppShell, Table's card
// mode, Modal's sheet mode and any page that branches its layout.
//
// Width is measured in EFFECTIVE CSS px: `window.innerWidth / bodyZoom`.
// The font-size preference is applied as `body { zoom }`, which shrinks
// the room content actually has; a 900px window at 1.32 zoom lays out
// like a 680px one and must count as narrow. (On phones the zoom is
// clamped to 1 — see fontScaleBootstrapScript / FontSizeControl — so
// there the division is a no-op.)
//
// The current narrow state is mirrored to `html[data-narrow="1"]` so
// theme.css can style structurally without duplicating the breakpoint.
// SSR-safe: server snapshot is false (wide) so hydration matches the
// desktop markup.

import { useSyncExternalStore } from 'react';

import { BREAKPOINTS } from './tokens';

export function effectiveViewportWidth(): number {
  if (typeof window === 'undefined') return BREAKPOINTS.narrow + 1;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--vibe-font-scale');
  const zoom = parseFloat(raw) || 1;
  return window.innerWidth / (zoom > 0 ? zoom : 1);
}

function isNarrowNow(breakpointPx: number): boolean {
  return effectiveViewportWidth() <= breakpointPx;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('resize', cb);
  // Fired by FontSizeControl when the zoom changes.
  window.addEventListener('vibe:font-scale', cb);
  return () => {
    window.removeEventListener('resize', cb);
    window.removeEventListener('vibe:font-scale', cb);
  };
}

// Keep html[data-narrow] in sync for CSS, independent of React trees.
if (typeof window !== 'undefined') {
  const mirror = (): void => {
    const narrow = isNarrowNow(BREAKPOINTS.narrow);
    if (narrow) document.documentElement.dataset['narrow'] = '1';
    else delete document.documentElement.dataset['narrow'];
  };
  mirror();
  window.addEventListener('resize', mirror);
  window.addEventListener('vibe:font-scale', mirror);
}

export function useIsNarrow(breakpointPx: number = BREAKPOINTS.narrow): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isNarrowNow(breakpointPx),
    () => false,
  );
}
