// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// App-level SMS inbox stream (D14). One EventSource per browser tab on
// /api/staff/sms/stream, with the house fallback to polling when SSE
// never delivers (no Redis, proxy buffering). Panels subscribe for live
// updates; the nav badge reads `unread`; Phase 9 raises desktop
// notifications from here so they fire on any page.

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

import { api } from '../api-client';
import type { SmsHealth, SmsStreamEvent } from '../pages/sms/types';

export type SmsStreamListener = (evt: SmsStreamEvent) => void;

export interface SmsStreamValue {
  unread: number;
  connected: 'sse' | 'poll' | 'off';
  health: SmsHealth | null;
  subscribe(fn: SmsStreamListener): () => void;
  refreshUnread(): void;
  /** the conversation currently open (used to suppress notifications) */
  setActiveConversation(id: string | null): void;
  activeConversationId: string | null;
  notifyEnabled: boolean;
  setNotifyEnabled(v: boolean): void;
}

const NOTIFY_KEY = '__vibe_sms_desktop_notify';
const POLL_MS = 20_000;
const HEALTH_MS = 5 * 60_000;

const Ctx = createContext<SmsStreamValue | null>(null);

function readNotifyPref(defaultOn: boolean): boolean {
  try {
    const v = localStorage.getItem(NOTIFY_KEY);
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch {
    /* storage unavailable */
  }
  return defaultOn;
}

export function SmsStreamProvider({
  enabled,
  meId,
  defaultNotify = false,
  onInbound,
  children,
}: {
  enabled: boolean;
  meId: string | null;
  defaultNotify?: boolean;
  /** Phase 9 — desktop notification hook, called for inbound message events. */
  onInbound?: (
    evt: Extract<SmsStreamEvent, { type: 'sms.message.created' }>,
    ctx: { activeConversationId: string | null },
    notifyEnabled: boolean,
  ) => void;
  children: ReactNode;
}): JSX.Element {
  const [unread, setUnread] = useState(0);
  const [connected, setConnected] = useState<'sse' | 'poll' | 'off'>('off');
  const [health, setHealth] = useState<SmsHealth | null>(null);
  const [activeConversationId, setActive] = useState<string | null>(null);
  const [notifyEnabled, setNotifyState] = useState<boolean>(() => readNotifyPref(defaultNotify));
  const listeners = useRef(new Set<SmsStreamListener>());
  const activeRef = useRef<string | null>(null);
  const onInboundRef = useRef(onInbound);
  onInboundRef.current = onInbound;
  const notifyRef = useRef(notifyEnabled);
  notifyRef.current = notifyEnabled;

  const emit = useCallback((evt: SmsStreamEvent) => {
    for (const fn of listeners.current) {
      try {
        fn(evt);
      } catch {
        /* listener errors never break the stream */
      }
    }
  }, []);

  const refreshUnread = useCallback(() => {
    if (!enabled) return;
    void api<{ unread: number }>('/api/staff/sms/unread-count')
      .then((r) => setUnread(r.unread ?? 0))
      .catch(() => undefined);
  }, [enabled]);

  const refreshHealth = useCallback(() => {
    if (!enabled) return;
    void api<SmsHealth>('/api/staff/sms/settings/health')
      .then(setHealth)
      .catch(() => undefined);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setConnected('off');
      setUnread(0);
      return;
    }
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: number | null = null;

    refreshUnread();
    refreshHealth();
    const healthTimer = window.setInterval(refreshHealth, HEALTH_MS);

    function startPolling(): void {
      if (pollTimer != null) return;
      setConnected('poll');
      pollTimer = window.setInterval(() => {
        refreshUnread();
        emit({ type: 'sms.refresh' });
      }, POLL_MS);
    }

    function handle(type: SmsStreamEvent['type'], raw: string): void {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      const evt = { ...data, type } as SmsStreamEvent;
      emit(evt);
      if (type === 'sms.message.created') {
        refreshUnread();
        onInboundRef.current?.(
          evt as Extract<SmsStreamEvent, { type: 'sms.message.created' }>,
          { activeConversationId: activeRef.current },
          notifyRef.current,
        );
      } else if (type === 'sms.conversation.updated') {
        refreshUnread();
      }
    }

    try {
      es = new EventSource('/api/staff/sms/stream?stream=1');
      let gotAny = false;
      es.onopen = () => {
        if (!cancelled) setConnected('sse');
      };
      for (const t of [
        'sms.message.created',
        'sms.message.status',
        'sms.conversation.updated',
      ] as const) {
        es.addEventListener(t, (ev) => {
          gotAny = true;
          handle(t, (ev as MessageEvent).data);
        });
      }
      es.addEventListener('unavailable', () => {
        es?.close();
        es = null;
        startPolling();
      });
      es.onerror = () => {
        if (cancelled) return;
        if (!gotAny) {
          es?.close();
          es = null;
          startPolling();
        }
      };
      // Even with SSE up, a slow safety poll keeps the badge honest.
      pollTimer = window.setInterval(refreshUnread, POLL_MS * 3);
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      es?.close();
      if (pollTimer != null) window.clearInterval(pollTimer);
      window.clearInterval(healthTimer);
    };
  }, [enabled, emit, refreshUnread, refreshHealth]);

  const value = useMemo<SmsStreamValue>(
    () => ({
      unread,
      connected,
      health,
      subscribe: (fn) => {
        listeners.current.add(fn);
        return () => {
          listeners.current.delete(fn);
        };
      },
      refreshUnread,
      setActiveConversation: (id) => {
        activeRef.current = id;
        setActive(id);
      },
      activeConversationId,
      notifyEnabled,
      setNotifyEnabled: (v) => {
        setNotifyState(v);
        try {
          localStorage.setItem(NOTIFY_KEY, v ? 'on' : 'off');
        } catch {
          /* ignore */
        }
      },
    }),
    [unread, connected, health, refreshUnread, activeConversationId, notifyEnabled],
  );

  void meId;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const OFF: SmsStreamValue = {
  unread: 0,
  connected: 'off',
  health: null,
  subscribe: () => () => undefined,
  refreshUnread: () => undefined,
  setActiveConversation: () => undefined,
  activeConversationId: null,
  notifyEnabled: false,
  setNotifyEnabled: () => undefined,
};

/** Read the stream; safe outside the provider (returns an inert value). */
export function useSmsStream(): SmsStreamValue {
  return useContext(Ctx) ?? OFF;
}
