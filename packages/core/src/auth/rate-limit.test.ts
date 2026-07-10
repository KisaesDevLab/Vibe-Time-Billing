// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, it, expect } from 'vitest';

import { checkAndIncrement, type RateLimiterDeps } from './rate-limit';

/** In-memory Redis-shaped sorted set, just enough to drive the limiter. */
function fakeRedis(): RateLimiterDeps & {
  _data: Map<string, { score: number; member: string }[]>;
} {
  const data = new Map<string, { score: number; member: string }[]>();
  return {
    _data: data,
    async zadd(key, score, member) {
      const arr = data.get(key) ?? [];
      arr.push({ score, member });
      data.set(key, arr);
      return 1;
    },
    async zremrangebyscore(key, min, max) {
      const arr = data.get(key);
      if (!arr) return 0;
      const kept = arr.filter((e) => e.score < min || e.score > max);
      data.set(key, kept);
      return arr.length - kept.length;
    },
    async zcard(key) {
      return data.get(key)?.length ?? 0;
    },
    async expire() {
      return 1;
    },
  };
}

describe('rate-limit', () => {
  it('allows up to max in a window then blocks', async () => {
    const redis = fakeRedis();
    const args = { key: 'rl:test', windowSeconds: 60, max: 3 };
    const now = 1_000_000;
    expect((await checkAndIncrement(redis, { ...args, now })).allowed).toBe(true);
    expect((await checkAndIncrement(redis, { ...args, now: now + 1 })).allowed).toBe(true);
    expect((await checkAndIncrement(redis, { ...args, now: now + 2 })).allowed).toBe(true);
    const blocked = await checkAndIncrement(redis, { ...args, now: now + 3 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
  });

  it('drops stale entries outside the window', async () => {
    const redis = fakeRedis();
    const args = { key: 'rl:slide', windowSeconds: 10, max: 2 };
    await checkAndIncrement(redis, { ...args, now: 0 });
    await checkAndIncrement(redis, { ...args, now: 1000 });
    // Far in the future — both prior entries should be evicted.
    const result = await checkAndIncrement(redis, { ...args, now: 1_000_000 });
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
  });

  it('reports remaining count', async () => {
    const redis = fakeRedis();
    const args = { key: 'rl:rem', windowSeconds: 60, max: 5 };
    const r1 = await checkAndIncrement(redis, { ...args, now: 1 });
    expect(r1.remaining).toBe(4);
    const r2 = await checkAndIncrement(redis, { ...args, now: 2 });
    expect(r2.remaining).toBe(3);
  });
});
