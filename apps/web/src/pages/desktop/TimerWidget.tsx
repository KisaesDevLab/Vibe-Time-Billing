// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-1 — the always-on-top timekeeping widget. Rendered in the shell's
// "timer" window (undecorated, 340×88, grows to show parked timers) inside
// its own TimerProvider, so it shares *server* state with the main window;
// every mutation goes through the same API as the header chip.
//
// Design rules:
//   - glanceable: one large tabular clock, one context line, state by colour
//     (green running / amber paused / neutral idle) + a pulsing dot
//   - one primary action per state (Start / Pause / Resume), big and on the
//     right where the pointer lands without looking
//   - everything else is quiet: switch (expands in place), finish, open
//   - whole surface drags the window except the controls

import { useEffect, useMemo, useState } from 'react';
import { tokens } from '@vibe/ui';

import {
  resizeTimerWidget,
  setTimerWidgetVisible,
  showMainWindow,
  openMainAt,
} from '../../lib/desktop';
import { formatClock, useTimers, useTimerTick, type TimerDto } from '../../timer-context';

const BASE_H = 88;
const ROW_H = 34;
const MAX_ROWS = 5;

function primaryLabel(t: TimerDto): string {
  return t.clientName ?? t.engagementName ?? (t.description || 'Untitled timer');
}
function secondaryLabel(t: TimerDto): string | null {
  if (t.clientName && t.engagementName) return t.engagementName;
  if (t.workCodeName) return t.workCodeName;
  if (t.clientName && t.description) return t.description;
  return null;
}

type Tone = 'running' | 'paused' | 'idle';

export function TimerWidgetPage(): JSX.Element {
  const { loaded, timers, running, elapsedSeconds, pause, resume, startTimer, refresh } =
    useTimers();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useTimerTick(running != null);

  const paused = useMemo(() => timers.filter((t) => t.status === 'PAUSED'), [timers]);
  const tone: Tone = running ? 'running' : paused.length ? 'paused' : 'idle';
  const focus = running ?? paused[0] ?? null;

  // Grow/shrink the native window with the parked list.
  useEffect(() => {
    const rows = open ? Math.min(paused.length, MAX_ROWS) : 0;
    void resizeTimerWidget(BASE_H + rows * ROW_H + (rows ? 8 : 0)).catch(() => undefined);
  }, [open, paused.length]);
  useEffect(() => {
    if (paused.length === 0) setOpen(false);
  }, [paused.length]);

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await fn();
    } catch {
      await refresh();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  const accent =
    tone === 'running'
      ? tokens.color.success
      : tone === 'paused'
        ? tokens.color.warning
        : tokens.color.textMuted;

  const iconBtn: React.CSSProperties = {
    width: 28,
    height: 28,
    display: 'inline-grid',
    placeItems: 'center',
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    color: tokens.color.textMuted,
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: 1,
    padding: 0,
  };

  return (
    <div
      data-tauri-drag-region
      style={{
        height: '100vh',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        background: tokens.color.surface,
        color: tokens.color.text,
        fontFamily: tokens.font.body,
        border: `1px solid ${tokens.color.border}`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: 12,
        overflow: 'hidden',
        userSelect: 'none',
        boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
      }}
    >
      <style>{`
        html, body, #root { background: transparent !important; margin: 0; }
        @keyframes vibe-pulse { 0%,100% { opacity: 1; transform: scale(1);} 50% { opacity: .45; transform: scale(.75);} }
        .vibe-w-btn:hover { background: var(--vibe-color-accent-muted) !important; color: var(--vibe-color-text) !important; }
        .vibe-w-primary:hover { filter: brightness(1.08); }
        .vibe-w-primary:active { transform: scale(.96); }
        .vibe-w-row:hover { background: var(--vibe-color-accent-muted); }
      `}</style>

      {/* ---- main strip ---- */}
      <div
        data-tauri-drag-region
        style={{
          height: BASE_H - 2,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 10px 0 14px',
        }}
      >
        {/* state dot */}
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: accent,
            flex: '0 0 auto',
            animation: tone === 'running' ? 'vibe-pulse 1.6s ease-in-out infinite' : undefined,
          }}
        />

        {/* clock + context (drag region) */}
        <div data-tauri-drag-region style={{ flex: 1, minWidth: 0 }}>
          <div
            data-tauri-drag-region
            style={{
              fontFamily: tokens.font.mono,
              fontVariantNumeric: 'tabular-nums',
              fontSize: 28,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              lineHeight: 1.05,
              color: tone === 'idle' ? tokens.color.textMuted : tokens.color.text,
            }}
          >
            {focus ? formatClock(elapsedSeconds(focus)) : '00:00'}
          </div>
          <div
            data-tauri-drag-region
            title={focus ? primaryLabel(focus) : undefined}
            style={{
              fontSize: 12,
              marginTop: 3,
              color: tokens.color.textMuted,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {!loaded ? (
              'Connecting…'
            ) : focus ? (
              <>
                <span style={{ color: tokens.color.text, fontWeight: 500 }}>
                  {primaryLabel(focus)}
                </span>
                {secondaryLabel(focus) && <span> · {secondaryLabel(focus)}</span>}
                {tone === 'paused' && (
                  <span style={{ color: tokens.color.warning }}> · paused</span>
                )}
              </>
            ) : (
              'No timer running'
            )}
          </div>
        </div>

        {/* secondary controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto' }}>
          {paused.length > 0 && (
            <button
              type="button"
              className="vibe-w-btn"
              style={{ ...iconBtn, color: open ? tokens.color.text : tokens.color.textMuted }}
              onClick={() => setOpen((v) => !v)}
              title={`${paused.length} parked timer${paused.length === 1 ? '' : 's'}`}
              aria-label="Switch timer"
              aria-expanded={open}
            >
              <span style={{ fontSize: 11, fontWeight: 600 }}>{paused.length}</span>
              <span style={{ fontSize: 9, marginLeft: 2 }}>{open ? '▲' : '▼'}</span>
            </button>
          )}
          {focus && (
            <button
              type="button"
              className="vibe-w-btn"
              style={iconBtn}
              onClick={() => void openMainAt(`/time?timerId=${encodeURIComponent(focus.id)}`)}
              title="Finish this timer on the Time page"
              aria-label="Finish timer"
            >
              ✓
            </button>
          )}
          <button
            type="button"
            className="vibe-w-btn"
            style={iconBtn}
            onClick={() => void showMainWindow()}
            title="Open Vibe"
            aria-label="Open Vibe"
          >
            ⤢
          </button>
          <button
            type="button"
            className="vibe-w-btn"
            style={{ ...iconBtn, width: 22 }}
            onClick={() => void setTimerWidgetVisible(false)}
            title="Hide widget (Ctrl+Shift+W)"
            aria-label="Hide widget"
          >
            ×
          </button>
        </div>

        {/* primary action */}
        <button
          type="button"
          className="vibe-w-primary"
          disabled={busy || !loaded}
          onClick={() =>
            void run(() =>
              running ? pause(running.id) : paused[0] ? resume(paused[0].id) : startTimer({}),
            )
          }
          title={
            running ? 'Pause' : paused[0] ? `Resume ${primaryLabel(paused[0])}` : 'Start a timer'
          }
          aria-label={running ? 'Pause' : 'Start'}
          style={{
            width: 44,
            height: 44,
            flex: '0 0 auto',
            borderRadius: 999,
            border: 'none',
            background: running ? tokens.color.warning : tokens.color.accent,
            color: '#fff',
            fontSize: 16,
            cursor: busy ? 'progress' : 'pointer',
            display: 'grid',
            placeItems: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
            transition: 'transform .08s ease, filter .12s ease',
            opacity: busy ? 0.7 : 1,
          }}
        >
          {running ? '❚❚' : '▶'}
        </button>
      </div>

      {/* ---- parked timers (expands the window) ---- */}
      {open && paused.length > 0 && (
        <div
          style={{
            borderTop: `1px solid ${tokens.color.border}`,
            padding: '4px 6px 4px 10px',
            overflowY: 'auto',
          }}
        >
          {paused.slice(0, MAX_ROWS).map((t) => (
            <button
              key={t.id}
              type="button"
              className="vibe-w-row"
              onClick={() => void run(() => resume(t.id))}
              disabled={busy}
              title={`Resume ${primaryLabel(t)}`}
              style={{
                width: '100%',
                height: ROW_H - 4,
                margin: '2px 0',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '0 8px',
                border: 'none',
                borderRadius: 6,
                background: 'transparent',
                color: tokens.color.text,
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 12,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: tokens.color.warning,
                  flex: '0 0 auto',
                }}
              />
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ fontWeight: 500 }}>{primaryLabel(t)}</span>
                {secondaryLabel(t) && (
                  <span style={{ color: tokens.color.textMuted }}> · {secondaryLabel(t)}</span>
                )}
              </span>
              <span
                style={{
                  fontFamily: tokens.font.mono,
                  fontVariantNumeric: 'tabular-nums',
                  color: tokens.color.textMuted,
                }}
              >
                {formatClock(t.elapsedSeconds)}
              </span>
              <span style={{ color: tokens.color.accent, fontSize: 11 }}>▶</span>
            </button>
          ))}
          {paused.length > MAX_ROWS && (
            <div style={{ fontSize: 11, color: tokens.color.textMuted, padding: '2px 8px' }}>
              +{paused.length - MAX_ROWS} more in Vibe
            </div>
          )}
        </div>
      )}
    </div>
  );
}
