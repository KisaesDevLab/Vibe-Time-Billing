// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-2 — client for GET /api/staff/events (see
// apps/api/src/notifications/staff-events.ts). One EventSource per tab;
// the Shell consumes `counts` for nav badges and `notification` /
// `appointment` for toasts (native ones inside the desktop shell).
//
// Resilience: exponential reconnect (1 s → 30 s). While disconnected the
// hook falls back to the old 30 s count polling so badges never go stale
// behind a proxy that drops long-lived responses.

import { useEffect, useRef, useState } from 'react';

import { api } from '../api-client';

export interface StaffCounts {
  teamUnread: number;
  notifUnread: number;
  requestsNew: number;
  intakeNew: number;
}

export const EMPTY_COUNTS: StaffCounts = {
  teamUnread: 0,
  notifUnread: 0,
  requestsNew: 0,
  intakeNew: 0,
};

export type StaffEventCategory =
  | 'message'
  | 'team'
  | 'intake'
  | 'request'
  | 'alert'
  | 'approval'
  | 'appointment'
  | 'system';

export interface StaffNotificationEvent {
  id: string;
  category: StaffEventCategory;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: string;
}

export interface StaffAppointmentEvent {
  id: string;
  title: string;
  startsAt: string;
  href: string;
  minutesUntil: number;
}

export interface StaffEventHandlers {
  onCounts?: (c: StaffCounts) => void;
  onNotification?: (n: StaffNotificationEvent) => void;
  onAppointment?: (a: StaffAppointmentEvent) => void;
}

export interface StaffEventsState {
  counts: StaffCounts;
  connected: boolean;
}

interface PollPerms {
  requests: boolean;
  intake: boolean;
}

async function pollCounts(perms: PollPerms): Promise<StaffCounts> {
  const [team, notif, req, intake] = await Promise.all([
    api<{ unread: number }>('/api/staff/internal-messaging/unread-count').catch(() => ({
      unread: 0,
    })),
    api<{ count: number }>('/api/staff/notifications/unread-count').catch(() => ({ count: 0 })),
    perms.requests
      ? api<{ count: number }>('/api/staff/requests/client-responses/unread-count').catch(() => ({
          count: 0,
        }))
      : Promise.resolve({ count: 0 }),
    perms.intake
      ? api<{ received: number; unread: number }>('/api/staff/intake/count').catch(() => ({
          received: 0,
          unread: 0,
        }))
      : Promise.resolve({ received: 0, unread: 0 }),
  ]);
  return {
    teamUnread: team.unread ?? 0,
    notifUnread: notif.count ?? 0,
    requestsNew: req.count ?? 0,
    intakeNew: intake.unread ?? intake.received ?? 0,
  };
}

/**
 * Subscribe to the staff event stream. `enabled` false (e.g. signed out)
 * tears everything down. Handlers are read through a ref so callers can
 * pass inline closures without re-opening the connection.
 */
export function useStaffEvents(
  enabled: boolean,
  perms: PollPerms,
  handlers: StaffEventHandlers,
): StaffEventsState {
  const [counts, setCounts] = useState<StaffCounts>(EMPTY_COUNTS);
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const permsRef = useRef(perms);
  permsRef.current = perms;

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let alive = true;
    let es: EventSource | null = null;
    let retryMs = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const applyCounts = (c: StaffCounts): void => {
      if (!alive) return;
      setCounts(c);
      handlersRef.current.onCounts?.(c);
    };

    const startPolling = (): void => {
      if (pollTimer) return;
      const run = (): void => {
        void pollCounts(permsRef.current).then(applyCounts);
      };
      run();
      pollTimer = setInterval(run, 30_000);
    };
    const stopPolling = (): void => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const connect = (): void => {
      if (!alive) return;
      try {
        es = new EventSource('/api/staff/events', { withCredentials: true });
      } catch {
        startPolling();
        return;
      }
      es.addEventListener('hello', (e) => {
        retryMs = 1000;
        setConnected(true);
        stopPolling();
        try {
          const data = JSON.parse((e as MessageEvent<string>).data) as { counts: StaffCounts };
          applyCounts(data.counts);
        } catch {
          /* ignore */
        }
      });
      es.addEventListener('counts', (e) => {
        try {
          applyCounts(JSON.parse((e as MessageEvent<string>).data) as StaffCounts);
        } catch {
          /* ignore */
        }
      });
      es.addEventListener('notification', (e) => {
        try {
          handlersRef.current.onNotification?.(
            JSON.parse((e as MessageEvent<string>).data) as StaffNotificationEvent,
          );
        } catch {
          /* ignore */
        }
      });
      es.addEventListener('appointment', (e) => {
        try {
          handlersRef.current.onAppointment?.(
            JSON.parse((e as MessageEvent<string>).data) as StaffAppointmentEvent,
          );
        } catch {
          /* ignore */
        }
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        if (!alive) return;
        startPolling();
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
    };

    connect();
    // Reconnect promptly when the tab/shell regains focus after sleep.
    const onVis = (): void => {
      if (document.visibilityState === 'visible' && !es && alive) {
        if (retryTimer) clearTimeout(retryTimer);
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVis);
      if (retryTimer) clearTimeout(retryTimer);
      stopPolling();
      es?.close();
      es = null;
      setConnected(false);
    };
  }, [enabled]);

  return { counts, connected };
}
