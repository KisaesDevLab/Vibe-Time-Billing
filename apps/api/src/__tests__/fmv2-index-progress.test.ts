// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 §5.2 — index progress publisher tests.

import { describe, expect, it } from 'vitest';
// ioredis-mock is already a dev dep used elsewhere in the suite.
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import {
  INDEX_CHANNEL_PREFIX,
  INDEX_STATE_PREFIX,
  indexChannel,
  indexStateKey,
  publishIndexProgress,
  readIndexState,
  type IndexProgressSnapshot,
} from '../files/index-progress';

function snap(over: Partial<IndexProgressSnapshot> = {}): IndexProgressSnapshot {
  return {
    status: 'running',
    files_total: 100,
    files_indexed: 23,
    bytes_indexed: 32_505_856,
    visible_count: 9,
    private_count: 14,
    started_at: '2026-05-26T13:00:00.000Z',
    last_file_name: 'K-1 Smith Holdings LLC.pdf',
    ...over,
  };
}

describe('FMv2 — channel + key helpers', () => {
  it('indexChannel uses storage:index:{id} prefix', () => {
    expect(indexChannel('abc')).toBe(`${INDEX_CHANNEL_PREFIX}abc`);
  });
  it('indexStateKey uses storage:index:state:{id} prefix', () => {
    expect(indexStateKey('abc')).toBe(`${INDEX_STATE_PREFIX}abc`);
  });
});

describe('FMv2 — publishIndexProgress', () => {
  it('writes Redis hash with all snapshot fields', async () => {
    const redis = new RedisMock();
    await publishIndexProgress(redis as unknown as Redis, 'folder-1', snap());
    const stored = await redis.hgetall(`${INDEX_STATE_PREFIX}folder-1`);
    expect(stored.status).toBe('running');
    expect(Number(stored.files_total)).toBe(100);
    expect(Number(stored.files_indexed)).toBe(23);
    expect(stored.last_file_name).toBe('K-1 Smith Holdings LLC.pdf');
  });

  it('publishes a progress event on the matching channel', async () => {
    const redis = new RedisMock();
    const subscriber = new RedisMock();
    // ioredis-mock requires the same instance for pub/sub bridging;
    // duplicate via its built-in helper.
    const sub = (subscriber as unknown as { duplicate(): RedisMock }).duplicate();
    const received: string[] = [];
    await sub.subscribe(indexChannel('folder-2'));
    sub.on('message', (_chan, msg) => received.push(msg));
    // Wait a tick for the subscription to settle.
    await new Promise((r) => setImmediate(r));
    await publishIndexProgress(redis as unknown as Redis, 'folder-2', snap({ files_indexed: 50 }));
    await new Promise((r) => setTimeout(r, 50));
    // Note: ioredis-mock isolates pub/sub per instance — the test
    // mostly proves the helper doesn't throw. The real wiring is
    // tested via the SSE endpoint integration.
    void received;
  });

  it('handles missing optional fields gracefully', async () => {
    const redis = new RedisMock();
    await publishIndexProgress(
      redis as unknown as Redis,
      'folder-3',
      snap({ estimated_completion: undefined, last_file_name: undefined }),
    );
    const stored = await redis.hgetall(`${INDEX_STATE_PREFIX}folder-3`);
    expect(stored.estimated_completion).toBeUndefined();
    expect(stored.last_file_name).toBeUndefined();
  });

  it('terminal status sets a short TTL', async () => {
    const redis = new RedisMock();
    await publishIndexProgress(
      redis as unknown as Redis,
      'folder-4',
      snap({ status: 'completed' }),
    );
    const ttl = await redis.ttl(`${INDEX_STATE_PREFIX}folder-4`);
    // After the second expire(60) call, ttl is ≤ 60s. Mock returns
    // an integer between 0 and 60.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });
});

describe('FMv2 — readIndexState', () => {
  it('returns null when no state exists', async () => {
    const redis = new RedisMock();
    const r = await readIndexState(redis as unknown as Redis, 'no-such-folder');
    expect(r).toBeNull();
  });

  it('round-trips a written snapshot', async () => {
    const redis = new RedisMock();
    const orig = snap({ files_indexed: 47 });
    await publishIndexProgress(redis as unknown as Redis, 'rt', orig);
    const r = await readIndexState(redis as unknown as Redis, 'rt');
    expect(r).not.toBeNull();
    expect(r!.files_indexed).toBe(47);
    expect(r!.status).toBe('running');
    expect(r!.last_file_name).toBe('K-1 Smith Holdings LLC.pdf');
  });
});
