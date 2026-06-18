// SPDX-License-Identifier: Elastic-2.0
//
// Shared positioning hook for portal-rendered popovers (Combobox,
// MultiCombobox, ColumnFilter). Computes viewport-relative top/left/
// width for a `position: fixed` popover anchored to a trigger element.
//
// Why portal + fixed positioning: when a trigger sits inside an
// ancestor with `overflow: auto/hidden/scroll`, an inline absolutely-
// positioned popover gets clipped by that scroll container. Rendering
// into document.body via createPortal escapes every ancestor's overflow
// and stacking context. Fixed positioning means viewport coordinates
// (no need to walk offsetParent chains).
//
// Auto-flips above the trigger when there isn't room below; horizontally
// clamps to keep the popover on-screen.

import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

export interface PopoverPosition {
  top: number;
  left: number;
  width: number;
  placement: 'above' | 'below';
}

export interface UsePopoverPositionInput {
  triggerRef: RefObject<HTMLElement>;
  open: boolean;
  /** Hard cap on the popover's height — used for flip detection. */
  popoverMaxHeight?: number;
  /** Minimum width so search inputs stay usable on narrow triggers. */
  minWidth?: number;
  /** Margin between popover edge and viewport edge. */
  viewportMargin?: number;
}

const SSR = typeof window === 'undefined';

/**
 * The accessibility font-size control applies `body { zoom: N }` (see
 * FontSizeControl), and these popovers portal into `document.body` — so a
 * fixed child is rendered at `cssLeft * zoom`. getBoundingClientRect() and
 * window.innerWidth report visual (post-zoom) pixels, so we compute in
 * visual space then divide the final CSS coords by the zoom to cancel the
 * body's re-scaling. Returns 1 when no body zoom is active.
 */
function bodyZoom(): number {
  if (SSR) return 1;
  const raw = getComputedStyle(document.body).zoom;
  const z = parseFloat(raw || '1');
  return Number.isFinite(z) && z > 0 ? z : 1;
}

export function usePopoverPosition({
  triggerRef,
  open,
  popoverMaxHeight = 320,
  minWidth = 200,
  viewportMargin = 8,
}: UsePopoverPositionInput): PopoverPosition | null {
  const [pos, setPos] = useState<PopoverPosition | null>(null);

  // Layout effect so we compute before paint — no one-frame flash at
  // the wrong position. useEffect would render once at (0,0) first.
  useLayoutEffect(() => {
    if (!open || SSR) {
      setPos(null);
      return;
    }
    function compute(): void {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;

      const width = Math.max(rect.width, minWidth);

      const spaceBelow = vh - rect.bottom;
      const spaceAbove = rect.top;
      // Prefer below; flip above when below is too tight AND above has
      // more room than below.
      const placement: 'above' | 'below' =
        spaceBelow < popoverMaxHeight + viewportMargin && spaceAbove > spaceBelow
          ? 'above'
          : 'below';

      let left = rect.left;
      // Clamp horizontally so we don't paint past the right edge.
      if (left + width > vw - viewportMargin) {
        left = Math.max(viewportMargin, vw - width - viewportMargin);
      }
      if (left < viewportMargin) left = viewportMargin;

      const top =
        placement === 'below'
          ? rect.bottom + 4
          : Math.max(viewportMargin, rect.top - popoverMaxHeight - 4);

      // Cancel the body zoom: the popover is a fixed child of the zoomed
      // <body>, so its CSS left/top/width are multiplied by the zoom on
      // paint. Dividing here lands it at the intended visual coordinates.
      const z = bodyZoom();
      setPos({ top: top / z, left: left / z, width: width / z, placement });
    }
    compute();
    // capture:true so scrolls inside scrollable ancestors (tables,
    // modals) also retrigger the recompute.
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('scroll', compute, opts);
    window.addEventListener('resize', compute, { passive: true });
    return () => {
      window.removeEventListener('scroll', compute, opts);
      window.removeEventListener('resize', compute);
    };
  }, [open, triggerRef, popoverMaxHeight, minWidth, viewportMargin]);

  // Wipe state on close so we don't paint a stale popover at the old
  // position the next time open flips back to true.
  useEffect(() => {
    if (!open) setPos(null);
  }, [open]);

  return pos;
}
