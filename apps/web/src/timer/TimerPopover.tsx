// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The timer panel behind the header chip: running-timer card (live
// elapsed, classify, editable start-time correction, pause/save/discard),
// the paused-timer parking lot (resume/save/discard each), start-new, and
// the forgotten-timer banner. Fixed-position panel + transparent
// click-away layer (QuickFind pattern) so it works above any page.

import { useState } from 'react';
import { createPortal } from 'react-dom';

import { Button, Combobox, tokens } from '@vibe/ui';

import {
  elapsedToHours,
  formatClock,
  formatHuman,
  useTimers,
  type TimerDto,
} from '../timer-context';
import { TimerSaveForm } from './TimerSaveForm';
import { useEngagementOptions } from './useEngagementOptions';

/** Uncontrolled-ish description input that patches on blur/Enter so we
 *  don't fire a PATCH per keystroke. */
function DescriptionField({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (v: string) => void;
}): JSX.Element {
  const [v, setV] = useState(initial);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v !== initial) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && v !== initial) onCommit(v);
      }}
      placeholder="What are you working on?"
      style={{
        padding: '5px 8px',
        fontSize: 12,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.surface,
        color: tokens.color.text,
        width: '100%',
        boxSizing: 'border-box',
      }}
    />
  );
}

function timerLabel(t: TimerDto): string {
  if (t.clientName && t.engagementName) return `${t.clientName} — ${t.engagementName}`;
  if (t.clientName) return t.clientName;
  if (t.description) return t.description;
  return 'Untitled timer';
}

/** "9:14 AM" for the running card's start-time correction affordance. */
function startTimeLabel(elapsed: number): string {
  return new Date(Date.now() - elapsed * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Screen position of the chip that opened the panel. The panel opens to
 *  the chip's right and grows toward whichever side has more room —
 *  downward now that the chip lives near the top of the nav. */
export interface PopoverAnchor {
  top: number;
  right: number;
  bottom: number;
}

export function TimerPopover({
  anchor,
  onClose,
}: {
  anchor: PopoverAnchor | null;
  onClose: () => void;
}): JSX.Element {
  const {
    timers,
    running,
    elapsedSeconds,
    startTimer,
    pause,
    resume,
    patchTimer,
    discard,
    staleTimer,
    acknowledgeStale,
  } = useTimers();
  const options = useEngagementOptions(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);
  const [editingTime, setEditingTime] = useState(false);
  const [timeDraft, setTimeDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);
  const paused = timers.filter((t) => t.status === 'PAUSED');
  const savingTimer = savingId ? (timers.find((t) => t.id === savingId) ?? null) : null;

  const ACTION_ERROR_LABELS: Record<string, string> = {
    timer_limit: 'Too many parked timers — save or discard one first.',
    timer_conflict: 'Another tab changed your timers — the list has been refreshed.',
    engagement_not_found: 'That engagement no longer exists.',
  };

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'request_failed';
      setActionError(ACTION_ERROR_LABELS[msg] ?? `Timer action failed (${msg}).`);
    } finally {
      setBusy(false);
    }
  }

  function beginEditTime(t: TimerDto): void {
    const e = elapsedSeconds(t);
    setTimeDraft(
      `${String(Math.floor(e / 3600)).padStart(2, '0')}:${String(Math.floor((e % 3600) / 60)).padStart(2, '0')}`,
    );
    setEditingTime(true);
  }

  async function commitEditTime(t: TimerDto): Promise<void> {
    const m = /^(\d{1,2}):([0-5]\d)$/.exec(timeDraft.trim());
    if (m) {
      const secs = Number(m[1]) * 3600 + Number(m[2]) * 60;
      await run(() => patchTimer(t.id, { elapsedSeconds: secs }));
    }
    setEditingTime(false);
  }

  const row: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 0',
  };
  const mono: React.CSSProperties = {
    fontFamily: tokens.font.mono,
    fontVariantNumeric: 'tabular-nums',
  };

  // Portaled to <body>: the chip lives inside the sidebar <aside>, which is
  // position:sticky and therefore its own stacking context — a fixed panel
  // rendered in place would paint UNDER later-DOM main content regardless of
  // z-index.
  return createPortal(
    <>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
      <div
        role="dialog"
        aria-label="Timers"
        style={{
          position: 'fixed',
          // Anchored to the chip: open to its right, growing toward the
          // side with more room (down when the chip is near the top of
          // the nav, up if it ever sits low). Fallback: top-right.
          ...(anchor
            ? {
                left: Math.max(8, Math.min(anchor.right + 8, window.innerWidth - 368)),
                ...(window.innerHeight - anchor.top >= anchor.bottom
                  ? {
                      top: Math.max(8, anchor.top),
                      maxHeight: Math.min(
                        window.innerHeight * 0.8,
                        window.innerHeight - anchor.top - 12,
                      ),
                    }
                  : {
                      bottom: Math.max(8, window.innerHeight - anchor.bottom),
                      maxHeight: Math.min(window.innerHeight * 0.8, anchor.bottom - 16),
                    }),
              }
            : { top: 52, right: 12, maxHeight: '75vh' }),
          width: 360,
          maxWidth: 'calc(100vw - 24px)',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          zIndex: 1000,
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          padding: 14,
          display: 'grid',
          gap: 12,
          alignContent: 'start',
        }}
      >
        {staleTimer && (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.color.warning}`,
              fontSize: 12,
              display: 'grid',
              gap: 6,
            }}
          >
            <span>
              You left a timer running{staleTimer.clientName ? ` (${staleTimer.clientName})` : ''} —
              check the tracked time before saving it.
            </span>
            <div>
              <Button size="sm" variant="ghost" onClick={acknowledgeStale}>
                Got it
              </Button>
            </div>
          </div>
        )}

        {actionError && (
          <div style={{ fontSize: 12, color: tokens.color.danger }}>{actionError}</div>
        )}

        {savingTimer ? (
          <TimerSaveForm
            timer={savingTimer}
            options={options}
            onSaved={() => setSavingId(null)}
            onCancel={() => setSavingId(null)}
          />
        ) : (
          <>
            {running ? (
              <div
                style={{
                  padding: 12,
                  borderRadius: tokens.radius.sm,
                  border: `1px solid ${tokens.color.accent}`,
                  display: 'grid',
                  gap: 8,
                }}
              >
                {running.engagementId ? (
                  <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {timerLabel(running)}
                  </div>
                ) : (
                  <Combobox
                    size="sm"
                    value=""
                    onChange={(v) => void run(() => patchTimer(running.id, { engagementId: v }))}
                    options={options.engagementOptions(running.clientId)}
                    placeholder={options.loading ? 'Loading…' : 'Assign engagement…'}
                    ariaLabel="Assign engagement to running timer"
                  />
                )}
                <DescriptionField
                  key={running.id}
                  initial={running.description}
                  onCommit={(v) => void run(() => patchTimer(running.id, { description: v }))}
                />
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ ...mono, fontSize: 26, fontWeight: 600 }}>
                    {formatClock(elapsedSeconds(running))}
                  </span>
                  <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                    ≈ {elapsedToHours(elapsedSeconds(running)).toFixed(2)} hr
                  </span>
                </div>
                {editingTime ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                    <span>Tracked (h:mm)</span>
                    <input
                      value={timeDraft}
                      onChange={(e) => setTimeDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitEditTime(running);
                        if (e.key === 'Escape') setEditingTime(false);
                      }}
                      style={{
                        width: 64,
                        padding: '3px 6px',
                        border: `1px solid ${tokens.color.border}`,
                        borderRadius: tokens.radius.sm,
                        background: tokens.color.surface,
                        color: tokens.color.text,
                        ...mono,
                      }}
                    />
                    <Button size="sm" variant="ghost" onClick={() => void commitEditTime(running)}>
                      Set
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => beginEditTime(running)}
                    title="Correct the tracked time (e.g. the call started before you hit start)"
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      textAlign: 'left',
                      fontSize: 11,
                      color: tokens.color.textMuted,
                      cursor: 'pointer',
                      textDecoration: 'underline dotted',
                    }}
                  >
                    Started around {startTimeLabel(elapsedSeconds(running))} — adjust
                  </button>
                )}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run(() => pause(running.id))}
                  >
                    ⏸ Pause
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => setSavingId(running.id)}>
                    ■ Stop &amp; save
                  </Button>
                  {confirmDiscardId === running.id ? (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() => void run(() => discard(running.id))}
                    >
                      Really discard?
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmDiscardId(running.id)}
                    >
                      Discard
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: tokens.color.textMuted }}>No timer running.</div>
            )}

            {paused.length > 0 && (
              <div style={{ display: 'grid', gap: 4 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: tokens.color.textMuted,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Paused
                </div>
                {paused.map((t) => (
                  <div key={t.id} style={{ ...row, borderTop: `1px solid ${tokens.color.border}` }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                        title={timerLabel(t)}
                      >
                        {timerLabel(t)}
                        {t.autoPausedAt && (
                          <span style={{ color: tokens.color.warning }}> · auto-paused</span>
                        )}
                      </div>
                      <div style={{ ...mono, fontSize: 12, color: tokens.color.textMuted }}>
                        {formatHuman(t.elapsedSeconds)}
                      </div>
                    </div>
                    {/* Action cluster is shrink-proof: the label column
                        truncates, the buttons never squeeze or overlap. */}
                    <span style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        title="Resume"
                        onClick={() => void run(() => resume(t.id))}
                      >
                        ▶
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        title="Save as time entry"
                        onClick={() => setSavingId(t.id)}
                      >
                        ✓
                      </Button>
                      {confirmDiscardId === t.id ? (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => void run(() => discard(t.id))}
                        >
                          Sure?
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          title="Discard"
                          onClick={() => setConfirmDiscardId(t.id)}
                        >
                          🗑
                        </Button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ borderTop: `1px solid ${tokens.color.border}`, paddingTop: 8 }}>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void run(() => startTimer())}
              >
                ▶ Start new timer
              </Button>
            </div>
          </>
        )}
      </div>
    </>,
    document.body,
  );
}
