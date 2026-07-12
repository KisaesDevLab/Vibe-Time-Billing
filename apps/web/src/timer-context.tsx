// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0207 — pause-and-hold stopwatch timers. This provider is mounted once
// inside the authed Shell so every staff page shares one timer state:
// the header chip, the /time page integrations, and the client/engagement
// "Start timer" buttons all talk to it. Server state is authoritative —
// every mutation response carries the full refreshed list and we replace
// wholesale (no merging); a 1-second local tick advances the display
// between syncs.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { api } from './api-client';
import { usePermission } from './auth-context';

export interface TimerDto {
  id: string;
  clientId: string | null;
  engagementId: string | null;
  workCodeId: string | null;
  sourceTimeEntryId: string | null;
  billableFlag: boolean | null;
  outOfScopeOverride: boolean | null;
  clientName: string | null;
  engagementName: string | null;
  workCodeName: string | null;
  description: string;
  status: 'RUNNING' | 'PAUSED';
  elapsedSeconds: number;
  lastStartedAt: string | null;
  startedAt: string;
  autoPausedAt: string | null;
  updatedAt: string;
}

interface TimerListResponse {
  items: TimerDto[];
  serverTime: string;
}

export interface TimerStartPrefill {
  clientId?: string;
  engagementId?: string;
  workCodeId?: string;
  description?: string;
  // 0209 — the logged entry a ▶ continue was pressed on (row indicator).
  sourceTimeEntryId?: string;
  // 0211 — carried from the source entry; save defaults follow them.
  billableFlag?: boolean;
  outOfScopeOverride?: boolean;
}

export interface TimerSaveFields {
  engagementId?: string;
  workCodeId?: string;
  entryDate?: string;
  hours?: number;
  description?: string;
  billableFlag?: boolean;
  outOfScopeOverride?: boolean;
  workflowState?: string;
}

interface TimerContextValue {
  /** Signed-in user may log time (time_entry:create). */
  canUse: boolean;
  loaded: boolean;
  timers: TimerDto[];
  running: TimerDto | null;
  /** Live elapsed for display — server snapshot + local clock advance. */
  elapsedSeconds(t: TimerDto): number;
  startTimer(prefill?: TimerStartPrefill): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  patchTimer(
    id: string,
    fields: Partial<TimerStartPrefill> & { elapsedSeconds?: number },
  ): Promise<void>;
  /** Converts to a time entry. Resolves with the created entry id; throws
   *  the ApiError (with server body) on rejection — the timer survives
   *  server-side as PAUSED. */
  saveTimer(id: string, fields: TimerSaveFields): Promise<string>;
  discard(id: string): Promise<void>;
  refresh(): Promise<void>;
  /** A forgotten timer worth flagging (auto-paused, or running since
   *  before today). Null once acknowledged this session. */
  staleTimer: TimerDto | null;
  acknowledgeStale(): void;
}

const TimerContext = createContext<TimerContextValue | null>(null);

/** Exact elapsed → decimal hours, mirroring the server (2 decimals,
 *  floor 0.01 — free-decimal capture, no billing-increment rounding). */
export function elapsedToHours(elapsedSeconds: number): number {
  return Math.max(0.01, Math.round((elapsedSeconds / 3600) * 100) / 100);
}

/** Local 1s re-render while `active` — keeps a live clock ticking in ONE
 *  component. The provider's context value is deliberately tick-stable so
 *  a running timer doesn't re-render every consumer (whole tables) each
 *  second; anything displaying elapsedSeconds() live must call this. */
export function useTimerTick(active: boolean): void {
  const [, setLocalTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => setLocalTick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [active]);
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatHuman(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The user's LOCAL calendar date for a timestamp (default: now). UTC
 *  slicing rolls to tomorrow at 6-7 PM US Central — wrong for "did this
 *  start yesterday?" checks and for defaulting entry dates. */
export function localDateIso(at?: string | number | Date): string {
  const d = at != null ? new Date(at) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

const STALE_ACK_KEY = '__vibe_timer_stale_acked';

export function TimerProvider({ children }: { children: ReactNode }): JSX.Element {
  const canUse = usePermission('time_entry:create');
  const [timers, setTimers] = useState<TimerDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  // When the list snapshot was taken, so RUNNING elapsed can advance
  // locally between syncs without clock-skew math.
  const fetchedAtMs = useRef<number>(Date.now());
  // Newest server snapshot applied so far. A slow poll response resolving
  // AFTER a mutation response must not overwrite the newer list (it would
  // hide a just-started timer for up to 60s).
  const appliedServerMs = useRef<number>(0);
  const [staleAcked, setStaleAcked] = useState(() => sessionStorage.getItem(STALE_ACK_KEY) === '1');

  const applyList = useCallback((r: TimerListResponse) => {
    const serverMs = Date.parse(r.serverTime);
    if (Number.isFinite(serverMs)) {
      if (serverMs < appliedServerMs.current) return; // stale response
      appliedServerMs.current = serverMs;
    }
    fetchedAtMs.current = Date.now();
    setTimers(r.items ?? []);
    setLoaded(true);
  }, []);

  const refresh = useCallback(async () => {
    if (!canUse) return;
    try {
      applyList(await api<TimerListResponse>('/api/staff/timers'));
    } catch {
      // Transient (network/auth churn); keep the last snapshot.
    }
  }, [canUse, applyList]);

  // Initial load + resync on focus/visibility + a slow safety poll.
  useEffect(() => {
    if (!canUse) return;
    void refresh();
    const onFocus = (): void => void refresh();
    const onVis = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    const iv = setInterval(() => void refresh(), 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(iv);
    };
  }, [canUse, refresh]);

  const running = useMemo(() => timers.find((t) => t.status === 'RUNNING') ?? null, [timers]);

  // Live 1s clocks are per-COMPONENT via useTimerTick — the provider itself
  // stays tick-free so a running timer never re-renders the whole tree.

  const elapsedSeconds = useCallback((t: TimerDto): number => {
    if (t.status !== 'RUNNING') return t.elapsedSeconds;
    return t.elapsedSeconds + Math.floor((Date.now() - fetchedAtMs.current) / 1000);
  }, []);

  // Tab title mirrors the running timer (⏱ 1:07 · Acme — Vibe T&B).
  const originalTitle = useRef<string | null>(null);
  useEffect(() => {
    if (originalTitle.current === null) originalTitle.current = document.title;
    if (!running) {
      document.title = originalTitle.current;
      return;
    }
    const update = (): void => {
      const secs = elapsedSeconds(running);
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const clock =
        h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `0:${String(m).padStart(2, '0')}`;
      const who = running.clientName ?? running.description ?? '';
      document.title = `⏱ ${clock}${who ? ` · ${who}` : ''} — ${originalTitle.current}`;
    };
    update();
    const iv = setInterval(update, 15_000);
    return () => {
      clearInterval(iv);
      if (originalTitle.current !== null) document.title = originalTitle.current;
    };
  }, [running, elapsedSeconds]);

  // Every mutation resyncs on failure: a 409 (concurrent tab paused it
  // first, timer_conflict, …) means our snapshot is stale — pull the truth
  // before rethrowing so the UI never keeps ticking on a dead timer.
  const mutate = useCallback(
    async (path: string, init?: { method: string; body?: string }) => {
      try {
        applyList(await api<TimerListResponse>(path, init));
      } catch (err) {
        void refresh();
        throw err;
      }
    },
    [applyList, refresh],
  );

  const startTimer = useCallback(
    async (prefill?: TimerStartPrefill) => {
      await mutate('/api/staff/timers', {
        method: 'POST',
        body: JSON.stringify(prefill ?? {}),
      });
    },
    [mutate],
  );

  const pause = useCallback(
    async (id: string) => {
      await mutate(`/api/staff/timers/${id}/pause`, { method: 'POST' });
    },
    [mutate],
  );

  const resume = useCallback(
    async (id: string) => {
      await mutate(`/api/staff/timers/${id}/resume`, { method: 'POST' });
    },
    [mutate],
  );

  const patchTimer = useCallback(
    async (id: string, fields: Partial<TimerStartPrefill> & { elapsedSeconds?: number }) => {
      await mutate(`/api/staff/timers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
      });
    },
    [mutate],
  );

  const saveTimer = useCallback(
    async (id: string, fields: TimerSaveFields): Promise<string> => {
      try {
        const r = await api<TimerListResponse & { id: string }>(`/api/staff/timers/${id}/save`, {
          method: 'POST',
          body: JSON.stringify(fields),
        });
        applyList(r);
        // Let open pages react (e.g. /time reloads its entries table when
        // a timer is quick-saved from the header popover).
        window.dispatchEvent(new Event('vibe:timer-saved'));
        return r.id;
      } catch (err) {
        // The server parked the timer as PAUSED before rejecting; resync
        // so the chip reflects that, then rethrow for the caller's UI.
        void refresh();
        throw err;
      }
    },
    [applyList, refresh],
  );

  const discard = useCallback(
    async (id: string) => {
      applyList(await api<TimerListResponse>(`/api/staff/timers/${id}`, { method: 'DELETE' }));
    },
    [applyList],
  );

  const staleTimer = useMemo(() => {
    if (staleAcked || !loaded) return null;
    const todayIso = localDateIso();
    return (
      timers.find(
        (t) =>
          t.autoPausedAt != null ||
          // "Left running overnight" — judge by the current running
          // segment (lastStartedAt), NOT startedAt: a parked timer
          // resumed daily is old by startedAt but not forgotten. Compare
          // LOCAL dates — UTC slicing false-alarms every US evening.
          (t.status === 'RUNNING' &&
            t.lastStartedAt != null &&
            localDateIso(t.lastStartedAt) < todayIso),
      ) ?? null
    );
  }, [timers, staleAcked, loaded]);

  const acknowledgeStale = useCallback(() => {
    sessionStorage.setItem(STALE_ACK_KEY, '1');
    setStaleAcked(true);
  }, []);

  const value = useMemo<TimerContextValue>(
    () => ({
      canUse,
      loaded,
      timers,
      running,
      elapsedSeconds,
      startTimer,
      pause,
      resume,
      patchTimer,
      saveTimer,
      discard,
      refresh,
      staleTimer,
      acknowledgeStale,
    }),
    [
      canUse,
      loaded,
      timers,
      running,
      elapsedSeconds,
      startTimer,
      pause,
      resume,
      patchTimer,
      saveTimer,
      discard,
      refresh,
      staleTimer,
      acknowledgeStale,
    ],
  );

  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
}

export function useTimers(): TimerContextValue {
  const ctx = useContext(TimerContext);
  if (!ctx) throw new Error('useTimers must be used inside TimerProvider');
  return ctx;
}

/** Null-safe variant for surfaces that may render outside the Shell
 *  (returns null instead of throwing). */
export function useTimersOptional(): TimerContextValue | null {
  return useContext(TimerContext);
}
