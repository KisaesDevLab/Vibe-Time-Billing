// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Play logging for the portal video player (0235).
//
//  - first `play` → POST /plays (records the play, may start the
//    delete-after-first-play clock)
//  - progress → PATCH /plays/:id at most every HEARTBEAT_MS, plus on
//    pause / ended / tab hidden / pagehide so the furthest point survives
//    the client closing the tab.
//
// Unload-time heartbeats use fetch keepalive through the shared api()
// wrapper, NOT navigator.sendBeacon: sendBeacon can only POST and cannot
// carry the X-CSRF-Token header the portal requires on every mutation.
// Every call swallows errors — a staff "view as client" session is
// rejected server-side and the player must keep working regardless.

import { api } from '../api-client';

export const HEARTBEAT_MS = 10_000;

export type DeviceKind = 'desktop' | 'mobile' | 'tablet' | 'unknown';

export function detectDeviceKind(ua: string = navigator.userAgent): DeviceKind {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Android.*Mobile|iPhone|iPod|Windows Phone|Mobile Safari|Opera Mini/i.test(ua))
    return 'mobile';
  if (/Android/i.test(ua)) return 'tablet';
  return 'desktop';
}

export interface PlayTracker {
  /** Call on the <video> `play` event. Idempotent. */
  onPlay(durationSeconds: number | null): void;
  /** Call on `timeupdate`; throttled internally. */
  onProgress(currentTime: number, durationSeconds: number | null): void;
  /** Call on pause / visibilitychange(hidden) / pagehide. */
  flush(currentTime: number, durationSeconds: number | null): void;
  /** Call on `ended`. */
  onEnded(durationSeconds: number | null): void;
}

export function createPlayTracker(videoId: string): PlayTracker {
  let playId: string | null = null;
  let starting: Promise<void> | null = null;
  let furthest = 0;
  let lastSentAt = 0;
  let lastSentFurthest = -1;
  let completed = false;

  async function send(
    duration: number | null,
    opts: { completed?: boolean; keepalive?: boolean } = {},
  ): Promise<void> {
    if (starting) await starting;
    if (!playId) return;
    if (!opts.completed && Math.round(furthest) === Math.round(lastSentFurthest)) return;
    lastSentAt = Date.now();
    lastSentFurthest = furthest;
    try {
      await api(`/api/portal/videos/${videoId}/plays/${playId}`, {
        method: 'PATCH',
        keepalive: opts.keepalive ?? false,
        body: JSON.stringify({
          furthestSeconds: Math.round(furthest * 10) / 10,
          ...(duration && Number.isFinite(duration) ? { durationSeconds: duration } : {}),
          ...(opts.completed ? { completed: true } : {}),
        }),
      });
    } catch {
      /* best-effort */
    }
  }

  return {
    onPlay(duration) {
      if (playId || starting) return;
      starting = api<{ playId: string }>(`/api/portal/videos/${videoId}/plays`, {
        method: 'POST',
        body: JSON.stringify({
          deviceKind: detectDeviceKind(),
          ...(duration && Number.isFinite(duration) ? { durationSeconds: duration } : {}),
        }),
      })
        .then((r) => {
          playId = r.playId;
        })
        .catch(() => undefined)
        .finally(() => {
          starting = null;
        });
    },
    onProgress(currentTime, duration) {
      if (currentTime > furthest) furthest = currentTime;
      if (Date.now() - lastSentAt >= HEARTBEAT_MS) void send(duration);
    },
    flush(currentTime, duration) {
      if (currentTime > furthest) furthest = currentTime;
      void send(duration, { keepalive: true });
    },
    onEnded(duration) {
      if (duration && Number.isFinite(duration)) furthest = Math.max(furthest, duration);
      if (completed) return;
      completed = true;
      void send(duration, { completed: true, keepalive: true });
    },
  };
}
