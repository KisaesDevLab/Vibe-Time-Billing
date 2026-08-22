// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-1 — the always-on-top mini timer. Rendered in the shell's second
// window ("timer", undecorated, ~300×72) at /desktop/timer, inside its own
// TimerProvider so it shares server state — not React state — with the
// main window. Every mutation here goes through the same API as the
// header chip; the main window picks the change up on its next sync or
// focus (the provider refreshes on focus/visibility).

import { useState } from 'react';
import { tokens } from '@vibe/ui';

import { setTimerWidgetVisible, showMainWindow } from '../../lib/desktop';
import { formatClock, useTimers, useTimerTick, type TimerDto } from '../../timer-context';

function label(t: TimerDto): string {
  return t.clientName ?? t.engagementName ?? (t.description || 'Untitled');
}

export function TimerWidgetPage(): JSX.Element {
  const { loaded, timers, running, elapsedSeconds, pause, resume, startTimer, refresh } =
    useTimers();
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(false);
  useTimerTick(running != null);

  const paused = timers.filter((t) => t.status === 'PAUSED');

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await fn();
    } catch {
      await refresh();
    } finally {
      setBusy(false);
      setPick(false);
    }
  }

  const btn: React.CSSProperties = {
    border: `1px solid ${tokens.color.border}`,
    background: tokens.color.surface,
    color: tokens.color.text,
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 12,
    cursor: 'pointer',
    lineHeight: 1.2,
  };

  return (
    <div
      data-tauri-drag-region
      style={{
        height: '100vh',
        boxSizing: 'border-box',
        padding: '8px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: tokens.color.surface,
        color: tokens.color.text,
        fontFamily: tokens.font.body,
        borderRadius: 10,
        border: `1px solid ${tokens.color.border}`,
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      <div data-tauri-drag-region style={{ flex: 1, minWidth: 0 }}>
        <div
          data-tauri-drag-region
          style={{
            fontVariantNumeric: 'tabular-nums',
            fontSize: 20,
            fontWeight: 600,
            color: running ? tokens.color.text : tokens.color.textMuted,
          }}
        >
          {running ? formatClock(elapsedSeconds(running)) : '0:00'}
        </div>
        <div
          data-tauri-drag-region
          style={{
            fontSize: 11,
            color: tokens.color.textMuted,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {!loaded
            ? 'Loading…'
            : running
              ? label(running)
              : paused.length
                ? `${paused.length} paused`
                : 'No timer running'}
        </div>
      </div>

      {running ? (
        <button
          type="button"
          style={btn}
          disabled={busy}
          onClick={() => void run(() => pause(running.id))}
          title="Pause"
        >
          ⏸
        </button>
      ) : paused.length === 1 ? (
        <button
          type="button"
          style={btn}
          disabled={busy}
          onClick={() => void run(() => resume(paused[0]!.id))}
          title={`Resume ${label(paused[0]!)}`}
        >
          ▶
        </button>
      ) : (
        <button
          type="button"
          style={btn}
          disabled={busy}
          onClick={() => void run(() => startTimer({}))}
          title="Start a new timer"
        >
          ▶
        </button>
      )}

      {paused.length > 0 && (
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            style={btn}
            disabled={busy}
            onClick={() => setPick((v) => !v)}
            title="Switch timer"
          >
            ⇄
          </button>
          {pick && (
            <ul
              style={{
                position: 'absolute',
                right: 0,
                bottom: '110%',
                margin: 0,
                padding: 4,
                listStyle: 'none',
                background: tokens.color.surface,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: 6,
                minWidth: 180,
                maxHeight: 160,
                overflowY: 'auto',
                boxShadow: '0 6px 20px rgba(0,0,0,0.2)',
              }}
            >
              {paused.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => void run(() => resume(t.id))}
                    style={{
                      ...btn,
                      border: 'none',
                      width: '100%',
                      textAlign: 'left',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label(t)}</span>
                    <span style={{ color: tokens.color.textMuted }}>
                      {formatClock(t.elapsedSeconds)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        type="button"
        style={btn}
        onClick={() => void showMainWindow()}
        title="Open Vibe"
        aria-label="Open Vibe"
      >
        ⤢
      </button>
      <button
        type="button"
        style={{ ...btn, border: 'none', padding: '4px 4px' }}
        onClick={() => void setTimerWidgetVisible(false)}
        title="Hide widget"
        aria-label="Hide widget"
      >
        ×
      </button>
    </div>
  );
}
