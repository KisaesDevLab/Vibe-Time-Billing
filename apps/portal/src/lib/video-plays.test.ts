// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ path: string; init?: RequestInit }> = [];
vi.mock('../api-client', () => ({
  api: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if ((init?.method ?? 'GET') === 'POST') return { playId: 'play-1' };
    return { ok: true };
  },
}));

import { HEARTBEAT_MS, createPlayTracker, detectDeviceKind } from './video-plays';

const body = (i: number): Record<string, unknown> =>
  JSON.parse(String(calls[i]?.init?.body ?? '{}')) as Record<string, unknown>;

describe('detectDeviceKind', () => {
  it('classifies common agents', () => {
    expect(detectDeviceKind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Safari')).toBe(
      'mobile',
    );
    expect(detectDeviceKind('Mozilla/5.0 (iPad; CPU OS 17_0) Safari')).toBe('tablet');
    expect(detectDeviceKind('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Chrome')).toBe(
      'mobile',
    );
    expect(detectDeviceKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome')).toBe('desktop');
  });
});

describe('createPlayTracker', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts the play once, throttles heartbeats, and always sends completion', async () => {
    const t = createPlayTracker('vid-1');
    t.onPlay(120);
    t.onPlay(120); // second play event after a pause — no second POST
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/portal/videos/vid-1/plays');
    expect(body(0)).toMatchObject({ durationSeconds: 120 });

    // First progress tick sends immediately (lastSentAt = 0).
    t.onProgress(5, 120);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init?.method).toBe('PATCH');
    expect(body(1)).toMatchObject({ furthestSeconds: 5, durationSeconds: 120 });

    // Within the heartbeat window: dropped.
    t.onProgress(9, 120);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);

    // After the window: sent with the furthest point (monotonic).
    vi.advanceTimersByTime(HEARTBEAT_MS);
    t.onProgress(7, 120); // scrubbed backwards — furthest stays 9
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(3);
    expect(body(2)).toMatchObject({ furthestSeconds: 9 });

    // Flush with no change since the last send is skipped.
    t.flush(9, 120);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(3);

    // Flush with progress goes out keepalive.
    t.flush(30, 120);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.init?.keepalive).toBe(true);

    // Ended → completed, once.
    t.onEnded(120);
    t.onEnded(120);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(5);
    expect(body(4)).toMatchObject({ completed: true, furthestSeconds: 120 });
  });

  it('never sends heartbeats before the play was recorded', async () => {
    const t = createPlayTracker('vid-2');
    t.onProgress(3, null);
    t.flush(3, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
  });
});
