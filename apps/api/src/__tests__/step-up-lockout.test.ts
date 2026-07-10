// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P1.2 — Step-up lockout integration test (I.11)
//
// Exercises the Redis-backed lockout helpers directly. The full
// requireStepUpWithLockout middleware requires a session — covered in
// `adjustment-stepup.test.ts` for the happy path; this file covers the
// lockout-state machine which is the more dangerous regression risk.

import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import { clearStepUpFailures, recordStepUpFailure } from '../auth/step-up-middleware';

const USER_A = '00000000-0000-0000-0000-aaaaaaaaaaaa';
const USER_B = '00000000-0000-0000-0000-bbbbbbbbbbbb';

describe('step-up lockout (I.11)', () => {
  let redis: Redis;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
  });

  it('records failures up to threshold and triggers lockout on the 5th', async () => {
    // First 4 failures: no lockout yet
    for (let i = 1; i <= 4; i++) {
      const locked = await recordStepUpFailure(redis, USER_A);
      expect(locked).toBe(false);
    }
    // 5th failure flips the lockout key
    const locked = await recordStepUpFailure(redis, USER_A);
    expect(locked).toBe(true);
    // Lockout key exists with TTL ≈ 30 minutes
    const ttl = await redis.ttl(`step-up:lockout:${USER_A}`);
    expect(ttl).toBeGreaterThan(1700); // tolerant lower bound (≤30 min)
    expect(ttl).toBeLessThanOrEqual(1800);
    // Failure counter is reset (so the next attempt counts from 1
    // again once the lockout window passes)
    const failureCount = await redis.get(`step-up:failures:${USER_A}`);
    expect(failureCount).toBeNull();
  });

  it('failure counter has a 15-minute window (TTL set on first failure)', async () => {
    await recordStepUpFailure(redis, USER_A);
    const ttl = await redis.ttl(`step-up:failures:${USER_A}`);
    expect(ttl).toBeGreaterThan(800); // ≤15 min
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it('lockouts are per-user — a different user is unaffected', async () => {
    for (let i = 0; i < 5; i++) {
      await recordStepUpFailure(redis, USER_A);
    }
    // A is locked
    expect(await redis.ttl(`step-up:lockout:${USER_A}`)).toBeGreaterThan(0);
    // B has no lockout key, no failure key
    expect(await redis.ttl(`step-up:lockout:${USER_B}`)).toBe(-2);
    expect(await redis.get(`step-up:failures:${USER_B}`)).toBeNull();
  });

  it('clearStepUpFailures drops the failure counter (e.g. on successful TOTP)', async () => {
    await recordStepUpFailure(redis, USER_A);
    await recordStepUpFailure(redis, USER_A);
    // Counter is at 2 — well below the threshold
    let count = await redis.get(`step-up:failures:${USER_A}`);
    expect(count).toBe('2');
    await clearStepUpFailures(redis, USER_A);
    count = await redis.get(`step-up:failures:${USER_A}`);
    expect(count).toBeNull();
    // And subsequent failures start fresh, not at 3
    const locked = await recordStepUpFailure(redis, USER_A);
    expect(locked).toBe(false);
    count = await redis.get(`step-up:failures:${USER_A}`);
    expect(count).toBe('1');
  });

  it('lockout expires when Redis TTL elapses (simulated)', async () => {
    // Force the lockout
    for (let i = 0; i < 5; i++) {
      await recordStepUpFailure(redis, USER_A);
    }
    expect(await redis.ttl(`step-up:lockout:${USER_A}`)).toBeGreaterThan(0);
    // Simulate TTL expiry by deleting the key (RedisMock doesn't
    // advance time; deletion is the equivalent observable outcome)
    await redis.del(`step-up:lockout:${USER_A}`);
    expect(await redis.ttl(`step-up:lockout:${USER_A}`)).toBe(-2);
    // Next failure starts a fresh window — only 1 strike, not 6
    const locked = await recordStepUpFailure(redis, USER_A);
    expect(locked).toBe(false);
    expect(await redis.get(`step-up:failures:${USER_A}`)).toBe('1');
  });

  it('a 6th attempt during lockout does not increment the counter back to active', async () => {
    // Lock the user
    for (let i = 0; i < 5; i++) {
      await recordStepUpFailure(redis, USER_A);
    }
    // The lockout key exists; the failure counter does not.
    // recordStepUpFailure still increments fresh if called during
    // lockout (it doesn't read the lockout key itself — that's the
    // middleware's job). This is documented behavior; the middleware
    // short-circuits before recordStepUpFailure runs while locked.
    // Verify counter starts at 1 after the lockout fires.
    const result = await recordStepUpFailure(redis, USER_A);
    expect(result).toBe(false);
    expect(await redis.get(`step-up:failures:${USER_A}`)).toBe('1');
  });
});
