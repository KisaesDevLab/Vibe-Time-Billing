// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Stopwatch row in the sidebar nav, directly under Dashboard (via the
// AppShell `navExtra` slot) so it's always in view — the sidebar footer
// proved easy to lose. Styled like a nav item: 24px glyph slot + label,
// icon-only in the collapsed rail. Shows the live running timer
// (▶ 1:07:12 · Acme), the paused count when nothing runs, or an idle
// "Timer" affordance. Turns amber (and auto-opens once per forgotten
// timer) when one needs attention. Clicking toggles the TimerPopover,
// anchored to the row's screen position.

import { useEffect, useRef, useState } from 'react';

import { tokens } from '@vibe/ui';

import { formatClock, useTimers, useTimerTick } from '../timer-context';
import { TimerPopover, type PopoverAnchor } from './TimerPopover';

export function TimerChip({ collapsed = false }: { collapsed?: boolean }): JSX.Element | null {
  const { canUse, loaded, timers, running, elapsedSeconds, staleTimer } = useTimers();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  useTimerTick(running != null);

  function openPanel(): void {
    const r = btnRef.current?.getBoundingClientRect();
    setAnchor(r ? { top: r.top, right: r.right, bottom: r.bottom } : null);
    setOpen(true);
  }

  // Surface a forgotten timer by opening the panel — but only once per
  // timer id. staleTimer is a fresh object every poll, so keying on the
  // object would reopen the panel every sync until acknowledged.
  const openedForStale = useRef<string | null>(null);
  useEffect(() => {
    if (staleTimer && openedForStale.current !== staleTimer.id) {
      openedForStale.current = staleTimer.id;
      openPanel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staleTimer]);

  if (!canUse || !loaded) return null;

  const pausedCount = timers.filter((t) => t.status === 'PAUSED').length;
  const stale = staleTimer != null;

  let glyph: string;
  let label: string;
  let title: string;
  if (running) {
    const who = running.clientName ?? (running.description || null);
    glyph = '▶';
    label = `${formatClock(elapsedSeconds(running))}${who ? ` · ${truncate(who, 14)}` : ''}`;
    title = `Timer running${who ? ` — ${who}` : ''} — click to manage`;
  } else if (pausedCount > 0) {
    glyph = '⏸';
    label = `${pausedCount} paused`;
    title = `${pausedCount} paused timer${pausedCount === 1 ? '' : 's'}`;
  } else {
    glyph = '⏱';
    label = 'Timer';
    title = 'Start a timer';
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        title={title}
        aria-label="Timers"
        style={{
          // Mirror the AppShell nav-item row so it reads as part of the menu.
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          justifyContent: collapsed ? 'center' : 'flex-start',
          width: '100%',
          padding: collapsed ? '8px 0' : '8px 12px',
          fontSize: 13,
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          borderRadius: tokens.radius.sm,
          background: running ? tokens.color.accentMuted : 'transparent',
          color: stale ? tokens.color.warning : running ? tokens.color.accent : tokens.color.text,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            minWidth: 24,
            fontSize: 13,
            fontWeight: running ? 600 : 500,
            color: stale
              ? tokens.color.warning
              : running
                ? tokens.color.accent
                : tokens.color.textMuted,
          }}
        >
          {glyph}
        </span>
        {!collapsed && (
          <span
            style={{
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              fontFamily: running ? tokens.font.mono : tokens.font.body,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {label}
          </span>
        )}
      </button>
      {open && <TimerPopover anchor={anchor} onClose={() => setOpen(false)} />}
    </>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
