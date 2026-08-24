// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-1 — glue between TimerProvider and the desktop shell. Mounted once
// inside TimerProvider (see App.tsx Shell) and renders nothing in the
// browser. Responsibilities:
//
//   tray        push the timer list + running clock into the tray menu and
//               tooltip whenever it changes; act on tray menu clicks
//   hotkeys     register the user's global shortcuts; act on them
//   idle        when the OS reports the user came back after ≥ threshold,
//               offer keep / trim / trim+pause for the running timer
//   foreground  (opt-in) when UltraTax is in front for a client we know,
//               offer to start a timer via a native toast
//   offline     tray/hotkey actions taken while the API is unreachable are
//               queued and replayed in order once we are back online
//
// The in-page timer UI (chip, popover, /time) is untouched; this only adds
// more ways to drive the same provider.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Modal, tokens } from '@vibe/ui';

import { api } from '../api-client';
import {
  isDesktop,
  looksLikeUltraTax,
  notify,
  onForegroundWindow,
  onHotkey,
  onIdleReturn,
  onNotificationClick,
  onTrayAction,
  setForegroundWatch,
  setHotkeys,
  setIdleThreshold,
  showMainWindow,
  toggleTimerWidget,
  syncTray,
  type TrayAction,
} from '../lib/desktop';
import { useDesktopSettings } from '../lib/desktop-settings';
import { formatHuman, useTimers, type TimerDto } from '../timer-context';

/** Window event the TimerChip listens to so "Start timer…" from the tray or
 *  a hotkey opens the same popover a click would. */
export const OPEN_TIMER_PANEL_EVENT = 'vibe:open-timer-panel';

const OFFLINE_QUEUE_KEY = '__vibe_timer_offline_queue';
const FG_SNOOZE_KEY = '__vibe_fg_snooze';

interface QueuedAction {
  kind: 'pause' | 'resume' | 'start';
  timerId?: string;
  clientId?: string;
  at: number;
}

function readQueue(): QueuedAction[] {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) ?? '[]') as QueuedAction[];
  } catch {
    return [];
  }
}
function writeQueue(q: QueuedAction[]): void {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* ignore */
  }
}

function isNetworkFailure(err: unknown): boolean {
  // fetch() rejects with TypeError when the API is unreachable; our ApiError
  // carries a status otherwise.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return err instanceof TypeError || (err as { status?: number }).status === undefined;
}

function timerLabel(t: TimerDto): string {
  return (
    t.clientName ??
    t.engagementName ??
    (t.description ? t.description.slice(0, 40) : null) ??
    'Untitled timer'
  );
}

/** UltraTax titles look like "UltraTax CS 2025 — 1040 — SMITH01 Smith, John".
 *  We only need a token that could be the firm's Client ID: alphanumeric,
 *  3–12 chars, not a bare form number / year (1040, 1120S, 2025) and not the
 *  product name. First such token wins; the server lookup is exact-match so
 *  a wrong guess just finds nothing. */
export function extractClientIdFromTitle(title: string): string | null {
  const cleaned = title.replace(/ultratax\s*cs/gi, ' ');
  // Hyphens inside a token are part of an id (ACME-LLC); surrounded by
  // spaces they are separators.
  const tokens = cleaned.split(/\s+[—–-]+\s+|[\s—–:|,()]+/).filter(Boolean);
  for (const t of tokens) {
    if (!/^[A-Z0-9]{3,12}(?:-[A-Z0-9]{1,6})?$/i.test(t)) continue;
    if (/^\d{4}$/.test(t)) continue; // year
    if (/^\d{3,4}[A-Z]{0,2}$/i.test(t)) continue; // 1040, 1120S, 1065, 990
    if (/^(cs|ut\d{2}|form|client|return)$/i.test(t)) continue;
    return t;
  }
  return null;
}

export function DesktopTimerBridge(): JSX.Element | null {
  const desktop = isDesktop();
  const timers = useTimers();
  const settings = useDesktopSettings();
  const navigate = useNavigate();
  const [idlePrompt, setIdlePrompt] = useState<{ idleSeconds: number; timerId: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const timersRef = useRef(timers);
  timersRef.current = timers;

  // ---- tray state -------------------------------------------------------------
  useEffect(() => {
    if (!desktop || !timers.loaded) return;
    const running = timers.running;
    void syncTray({
      timers: timers.timers.map((t) => ({ id: t.id, label: timerLabel(t), status: t.status })),
      activeId: running?.id ?? null,
      activeLabel: running ? timerLabel(running) : null,
      activeElapsedSeconds: running ? timers.elapsedSeconds(running) : 0,
      syncedAtMs: Date.now(),
    }).catch(() => undefined);
  }, [desktop, timers.loaded, timers.timers, timers.running, timers.elapsedSeconds, timers]);

  // ---- offline queue -------------------------------------------------------------
  const replayQueue = useCallback(async () => {
    const q = readQueue();
    if (q.length === 0) return;
    const t = timersRef.current;
    const remaining: QueuedAction[] = [];
    for (const a of q) {
      try {
        if (a.kind === 'pause' && a.timerId) await t.pause(a.timerId);
        else if (a.kind === 'resume' && a.timerId) await t.resume(a.timerId);
        else if (a.kind === 'start') await t.startTimer(a.clientId ? { clientId: a.clientId } : {});
      } catch (err) {
        if (isNetworkFailure(err)) {
          remaining.push(a, ...q.slice(q.indexOf(a) + 1));
          break;
        }
        // A 409/404 means the world moved on; drop it.
      }
    }
    writeQueue(remaining);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    const onOnline = (): void => void replayQueue();
    window.addEventListener('online', onOnline);
    const iv = setInterval(() => void replayQueue(), 30_000);
    void replayQueue();
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(iv);
    };
  }, [desktop, replayQueue]);

  const runOrQueue = useCallback(async (a: QueuedAction, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      if (isNetworkFailure(err)) {
        writeQueue([...readQueue(), a]);
        void notify({
          id: `offline:${a.at}`,
          title: 'Saved offline',
          body: 'The timer change will sync when the server is reachable.',
          category: 'system',
        }).catch(() => undefined);
      }
    }
  }, []);

  // ---- actions from tray / hotkeys -------------------------------------------------
  const act = useCallback(
    async (a: TrayAction) => {
      const t = timersRef.current;
      const now = Date.now();
      switch (a.kind) {
        case 'open':
          await showMainWindow().catch(() => undefined);
          return;
        case 'widget':
          await toggleTimerWidget().catch(() => undefined);
          return;
        case 'start':
          await showMainWindow().catch(() => undefined);
          window.dispatchEvent(new Event(OPEN_TIMER_PANEL_EVENT));
          return;
        case 'pause': {
          const id = a.timerId ?? t.running?.id;
          if (id) await runOrQueue({ kind: 'pause', timerId: id, at: now }, () => t.pause(id));
          return;
        }
        case 'resume':
        case 'switch': {
          const id = a.timerId ?? t.timers.find((x) => x.status === 'PAUSED')?.id;
          if (id) await runOrQueue({ kind: 'resume', timerId: id, at: now }, () => t.resume(id));
          return;
        }
        case 'finish': {
          const id = a.timerId ?? t.running?.id ?? t.timers[0]?.id;
          await showMainWindow().catch(() => undefined);
          if (id) navigate(`/time?timerId=${encodeURIComponent(id)}`);
          else navigate('/time');
          return;
        }
        case 'discard': {
          if (a.timerId) await t.discard(a.timerId).catch(() => undefined);
          return;
        }
      }
    },
    [navigate, runOrQueue],
  );

  useEffect(() => {
    if (!desktop) return;
    const offTray = onTrayAction((a) => void act(a));
    const offHotkey = onHotkey((kind) => {
      const t = timersRef.current;
      if (kind === 'toggle') {
        if (t.running) void act({ kind: 'pause', timerId: t.running.id });
        else void act({ kind: 'resume' });
      } else if (kind === 'start') {
        void act({ kind: 'start' });
      } else if (kind === 'widget') {
        void act({ kind: 'widget' });
      }
    });
    return () => {
      offTray();
      offHotkey();
    };
  }, [desktop, act]);

  // ---- push settings into the shell ------------------------------------------------------
  useEffect(() => {
    if (!desktop) return;
    void setHotkeys(settings.hotkeys).catch(() => undefined);
  }, [desktop, settings.hotkeys]);
  useEffect(() => {
    if (!desktop) return;
    void setIdleThreshold(settings.idleThresholdMinutes * 60).catch(() => undefined);
  }, [desktop, settings.idleThresholdMinutes]);
  useEffect(() => {
    if (!desktop) return;
    void setForegroundWatch(settings.foregroundSuggestions).catch(() => undefined);
  }, [desktop, settings.foregroundSuggestions]);

  // ---- idle return ------------------------------------------------------------------------------
  useEffect(() => {
    if (!desktop) return;
    return onIdleReturn((idleSeconds) => {
      const running = timersRef.current.running;
      if (!running) return;
      setIdlePrompt({ idleSeconds, timerId: running.id });
      void showMainWindow().catch(() => undefined);
    });
  }, [desktop]);

  async function resolveIdle(choice: 'keep' | 'trim' | 'stop'): Promise<void> {
    if (!idlePrompt) return;
    setBusy(true);
    try {
      if (choice !== 'keep') {
        await api(`/api/staff/timers/${idlePrompt.timerId}/trim`, {
          method: 'POST',
          body: JSON.stringify({ seconds: idlePrompt.idleSeconds, pause: choice === 'stop' }),
        });
        await timers.refresh();
      }
    } catch {
      /* the timer keeps its time; the user can fix it on /time */
    } finally {
      setBusy(false);
      setIdlePrompt(null);
    }
  }

  // ---- foreground suggestions ---------------------------------------------------------------------
  const lastSuggested = useRef<string | null>(null);
  useEffect(() => {
    if (!desktop || !settings.foregroundSuggestions) return;
    const offFg = onForegroundWindow((w) => {
      if (!looksLikeUltraTax(w)) return;
      const externalId = extractClientIdFromTitle(w.title);
      if (!externalId || externalId === lastSuggested.current) return;
      lastSuggested.current = externalId;
      void (async () => {
        try {
          const snoozed = JSON.parse(localStorage.getItem(FG_SNOOZE_KEY) ?? '{}') as Record<
            string,
            string
          >;
          const today = new Date().toDateString();
          if (snoozed[externalId] === today) return;
          const r = await api<{ items: Array<{ id: string; name: string }> }>(
            `/api/staff/clients?externalId=${encodeURIComponent(externalId)}`,
          );
          const client = r.items[0];
          if (!client) return;
          const t = timersRef.current;
          if (t.running?.clientId === client.id) return;
          snoozed[externalId] = today;
          localStorage.setItem(FG_SNOOZE_KEY, JSON.stringify(snoozed));
          await notify({
            id: `fg:${client.id}`,
            title: `Start a timer for ${client.name}?`,
            body: 'UltraTax CS is showing this client. Click to start timing.',
            href: `vibe-action://start-timer/${client.id}`,
            category: 'system',
          });
        } catch {
          /* ignore */
        }
      })();
    });
    return offFg;
  }, [desktop, settings.foregroundSuggestions]);

  // Native toast clicks that carry an in-app action (not a route).
  useEffect(() => {
    if (!desktop) return;
    return onNotificationClick(({ href }) => {
      const m = href && /^vibe-action:\/\/start-timer\/([0-9a-f-]{36})$/i.exec(href);
      if (m) {
        const clientId = m[1]!;
        void runOrQueue({ kind: 'start', clientId, at: Date.now() }, () =>
          timersRef.current.startTimer({ clientId }),
        );
      }
    });
  }, [desktop, runOrQueue]);

  if (!desktop) return null;
  if (!idlePrompt) return null;

  const away = formatHuman(idlePrompt.idleSeconds);
  return (
    <Modal title="Welcome back" onClose={() => void resolveIdle('keep')} minWidth={380}>
      <p style={{ margin: '0 0 12px', fontSize: 14 }}>
        You were away for <strong>{away}</strong> while a timer was running.
      </p>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: tokens.color.textMuted }}>
        What should happen to that time?
      </p>
      <div style={{ display: 'flex', gap: tokens.space.sm, flexWrap: 'wrap' }}>
        <Button onClick={() => void resolveIdle('keep')} disabled={busy}>
          Keep it
        </Button>
        <Button variant="secondary" onClick={() => void resolveIdle('trim')} disabled={busy}>
          Discard {away}, keep running
        </Button>
        <Button variant="ghost" onClick={() => void resolveIdle('stop')} disabled={busy}>
          Stop at the moment I left
        </Button>
      </div>
    </Modal>
  );
}
