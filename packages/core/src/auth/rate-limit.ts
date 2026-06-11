// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Sliding-window rate limiter.
//
// Q29 locked decision: account-enumeration mitigation uses these limits
// for magic-link issuance and SMS OTP. Backed by Redis sorted sets.

import { randomBytes } from 'node:crypto';

export interface RateLimiterDeps {
  zadd: (key: string, score: number, member: string) => Promise<unknown>;
  zremrangebyscore: (key: string, min: number, max: number) => Promise<unknown>;
  zcard: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<unknown>;
}

export interface RateLimitArgs {
  key: string;
  windowSeconds: number;
  max: number;
  now?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfterSeconds: number;
}

export async function checkAndIncrement(
  deps: RateLimiterDeps,
  args: RateLimitArgs,
): Promise<RateLimitResult> {
  const now = args.now ?? Date.now();
  const windowMs = args.windowSeconds * 1000;
  const cutoff = now - windowMs;
  // Unique ZSET member per call (dedup only — not a security token, but use
  // CSPRNG bytes so distinct same-millisecond calls never collide).
  const member = `${now}:${randomBytes(8).toString('hex')}`;

  await deps.zremrangebyscore(args.key, 0, cutoff);
  const beforeCount = await deps.zcard(args.key);

  if (beforeCount >= args.max) {
    return {
      allowed: false,
      count: beforeCount,
      remaining: 0,
      retryAfterSeconds: args.windowSeconds,
    };
  }

  await deps.zadd(args.key, now, member);
  await deps.expire(args.key, args.windowSeconds);

  const afterCount = beforeCount + 1;
  return {
    allowed: true,
    count: afterCount,
    remaining: Math.max(0, args.max - afterCount),
    retryAfterSeconds: 0,
  };
}
