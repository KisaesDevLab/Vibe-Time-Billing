// SPDX-License-Identifier: Elastic-2.0
//
// Stage 1B — extended step-up. Layered on top of the existing
// `requireStepUp` middleware in `middleware.ts`:
//
//   1. Redis-backed lockout — 5 failed step-up challenges in 15 minutes
//      locks the user out for 30 minutes. Tracks failures by appUserId.
//      Defense in depth against TOTP-brute-force / replay attempts.
//   2. Threshold-based gating — refund / write-off / credit application
//      amounts above the firm's configured threshold require a fresh
//      step-up. Below-threshold operations proceed without step-up.
//
// The plan (image-9-we-velvet-shell.md, Phase I): refund, write-off >
// threshold, invoice void, credit application > threshold.

import type { NextFunction, Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';

import { isStepUpFresh } from '@vibe/core/auth';
import type { Database } from '@vibe/db';
import { firmConfig } from '@vibe/db/schema';

import { loadConfig } from '../config';
import { logger } from '../logger';

const LOCKOUT_WINDOW_SEC = 15 * 60;
const LOCKOUT_MAX_FAILURES = 5;
const LOCKOUT_DURATION_SEC = 30 * 60;

function lockoutKey(appUserId: string): string {
  return `step-up:lockout:${appUserId}`;
}
function failuresKey(appUserId: string): string {
  return `step-up:failures:${appUserId}`;
}

/**
 * Inspect lockout state. Returns the remaining lock TTL in seconds if
 * the user is currently locked out, else null.
 */
async function getLockoutTtl(redis: Redis, appUserId: string): Promise<number | null> {
  const ttl = await redis.ttl(lockoutKey(appUserId));
  if (ttl > 0) return ttl;
  return null;
}

/**
 * Record a failed step-up challenge. Returns true if this failure
 * triggered a fresh lockout, false otherwise. Caller may surface that
 * in the 429 response.
 */
export async function recordStepUpFailure(redis: Redis, appUserId: string): Promise<boolean> {
  const k = failuresKey(appUserId);
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, LOCKOUT_WINDOW_SEC);
  if (count >= LOCKOUT_MAX_FAILURES) {
    await redis.set(lockoutKey(appUserId), '1', 'EX', LOCKOUT_DURATION_SEC);
    await redis.del(k);
    return true;
  }
  return false;
}

/** Clear any pending failure counter on a successful step-up. */
export async function clearStepUpFailures(redis: Redis, appUserId: string): Promise<void> {
  await redis.del(failuresKey(appUserId));
}

/**
 * Replacement for `requireStepUp` that adds Redis-backed lockout.
 * Wraps the same freshness check, but on a stale session it also
 * increments the user's failure counter so probing is bounded.
 */
export function requireStepUpWithLockout(redis: Redis) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const lockTtl = await getLockoutTtl(redis, session.appUserId);
    if (lockTtl != null) {
      res.status(429).json({ error: 'step_up_locked_out', retryAfter: lockTtl });
      return;
    }
    const cfg = loadConfig();
    if (!isStepUpFresh(session, cfg.STEP_UP_TIMEOUT_MINUTES)) {
      const lockedNow = await recordStepUpFailure(redis, session.appUserId);
      res.status(403).json({
        error: 'step_up_required',
        lockedOut: lockedNow,
      });
      return;
    }
    next();
  };
}

/**
 * In-handler step-up enforcement for actions whose threshold depends
 * on the request body. Read the firm's threshold from firm_config, and
 * if the amount exceeds it, require step-up. Returns true if the
 * request should proceed; on false the response has already been
 * written (403 or 429) and the caller should bail.
 *
 * `thresholdKey` selects which firm_config column to read.
 */
export async function ensureStepUpForAmount(
  req: Request,
  res: Response,
  deps: { db: Database | null; redis: Redis },
  args: {
    amountCents: number;
    thresholdKey: 'writeOffStepUpThresholdCents' | 'creditStepUpThresholdCents';
    firmId: string;
  },
): Promise<boolean> {
  const session = req.staffSession;
  if (!session) {
    res.status(401).json({ error: 'no_session' });
    return false;
  }
  const lockTtl = await getLockoutTtl(deps.redis, session.appUserId);
  if (lockTtl != null) {
    res.status(429).json({ error: 'step_up_locked_out', retryAfter: lockTtl });
    return false;
  }
  const threshold = await getThreshold(deps.db, args.firmId, args.thresholdKey);
  if (args.amountCents < threshold) return true;

  const cfg = loadConfig();
  if (isStepUpFresh(session, cfg.STEP_UP_TIMEOUT_MINUTES)) return true;

  const lockedNow = await recordStepUpFailure(deps.redis, session.appUserId);
  res.status(403).json({
    error: 'step_up_required',
    reason: 'amount_above_threshold',
    threshold,
    lockedOut: lockedNow,
  });
  return false;
}

async function getThreshold(
  db: Database | null,
  firmId: string,
  key: 'writeOffStepUpThresholdCents' | 'creditStepUpThresholdCents',
): Promise<number> {
  // Fallback default mirrors the firm_config column default (500.00).
  const DEFAULT = 50000;
  if (!db) return DEFAULT;
  try {
    const [row] = await db
      .select({
        writeOff: firmConfig.writeOffStepUpThresholdCents,
        credit: firmConfig.creditStepUpThresholdCents,
      })
      .from(firmConfig)
      .where(eq(firmConfig.firmId, firmId))
      .limit(1);
    if (!row) return DEFAULT;
    return Number(key === 'writeOffStepUpThresholdCents' ? row.writeOff : row.credit) || DEFAULT;
  } catch (err) {
    logger.warn({ err, firmId, key }, 'step-up: failed to load threshold, using default');
    return DEFAULT;
  }
}
