// SPDX-License-Identifier: Elastic-2.0
//
// Admin unlock endpoints. Operator POSTs the firm passphrase here at
// boot (admin-passphrase mode only). Sealed-on-disk mode never reaches
// this route — the lock middleware lets traffic through transparently.
//
// Endpoints:
//   GET  /status   — public; reports whether the appliance is locked.
//   POST /unlock   — public input (raw passphrase), but rate-limited
//                    aggressively. On first call in admin-passphrase
//                    mode without an existing envelope this also
//                    bootstraps. Subsequent calls unseal an existing
//                    envelope.
//   POST /lock     — staff-authenticated, RBAC-gated (crypto:unlock).
//                    Forgets the live MFK; appliance becomes locked
//                    until next /unlock.

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { firmConfig } from '@vibe/db/schema';
import { eq } from 'drizzle-orm';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

import { getApplianceLockState, setApplianceLockState, type LockState } from '../crypto/boot';
import { getFirmKeyManager } from '../crypto/manager';
import { logger } from '../logger';

const UnlockSchema = z.object({
  passphrase: z.string().min(8).max(512),
});

const MigrateModeSchema = z.object({
  targetMode: z.literal('admin-passphrase'),
  passphrase: z.string().min(12).max(512),
  acknowledgeIrreversible: z.literal(true),
});

const RATE_LIMIT_WINDOW_SEC = 5 * 60; // 5 minutes
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_BACKOFF_SEC = 15 * 60; // 15 minutes after 3 fails

async function checkRateLimit(
  redis: Redis,
  ip: string,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const key = `crypto:unlock:rate:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
  }
  if (count > RATE_LIMIT_MAX) {
    const lockKey = `crypto:unlock:lock:${ip}`;
    await redis.set(lockKey, '1', 'EX', RATE_LIMIT_BACKOFF_SEC);
    return { ok: false, retryAfter: RATE_LIMIT_BACKOFF_SEC };
  }
  return { ok: true };
}

async function isLockedOut(redis: Redis, ip: string): Promise<number | null> {
  const lockKey = `crypto:unlock:lock:${ip}`;
  const ttl = await redis.ttl(lockKey);
  if (ttl > 0) return ttl;
  return null;
}

export interface UnlockRoutesDeps extends RbacDeps {
  db: Database | null;
  redis: Redis;
  /**
   * Chain to apply to mutation routes that need a staff session. The
   * unlock router is mounted before global staff-auth (so /unlock works
   * pre-login), so /lock has to opt into auth itself.
   */
  requireAuth: (req: Request, res: Response, next: NextFunction) => unknown;
  requireCsrf: (req: Request, res: Response, next: NextFunction) => unknown;
}

export function createUnlockRouter(deps: UnlockRoutesDeps): Router {
  const router = express.Router();

  router.get('/status', (_req: Request, res: Response) => {
    const s = getApplianceLockState();
    res.json(serializeState(s));
  });

  router.post('/unlock', async (req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const ip = (req.ip ?? 'unknown').toString();

    const locked = await isLockedOut(deps.redis, ip);
    if (locked != null) {
      res.status(429).json({ error: 'rate_limited', retryAfter: locked });
      return;
    }

    const parsed = UnlockSchema.safeParse(req.body);
    if (!parsed.success) {
      const limit = await checkRateLimit(deps.redis, ip);
      if (!limit.ok) {
        res.status(429).json({ error: 'rate_limited', retryAfter: limit.retryAfter });
        return;
      }
      res.status(400).json({ error: 'invalid_input' });
      return;
    }

    const state = getApplianceLockState();
    if (state.kind === 'no-firm') {
      res.status(503).json({ error: 'no_firm', message: 'appliance has no firm row yet' });
      return;
    }
    if (state.kind === 'unlocked') {
      res.json({ ok: true, alreadyUnlocked: true });
      return;
    }

    const mgr = getFirmKeyManager(deps.db);

    try {
      if (state.kind === 'not-bootstrapped') {
        await mgr.bootstrap({
          firmId: state.firmId,
          mode: 'admin-passphrase',
          passphrase: parsed.data.passphrase,
        });
        setApplianceLockState({ kind: 'unlocked', firmId: state.firmId });
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'firm_key_envelope',
          entityId: state.firmId,
          ip,
          userAgent: req.get('user-agent') ?? null,
          after: { bootstrapped: true, mode: 'admin-passphrase' },
        });
        logger.info({ firmId: state.firmId }, 'crypto: envelope bootstrapped via /unlock');
        res.json({ ok: true, bootstrapped: true });
        return;
      }
      await mgr.unseal({ firmId: state.firmId, passphrase: parsed.data.passphrase });
      setApplianceLockState({ kind: 'unlocked', firmId: state.firmId });
      await emitAudit(deps.db, {
        action: 'LOGIN',
        entityType: 'firm_key_envelope',
        entityId: state.firmId,
        ip,
        userAgent: req.get('user-agent') ?? null,
        after: { unsealed: true },
      });
      logger.info({ firmId: state.firmId }, 'crypto: appliance unsealed');
      res.json({ ok: true });
    } catch (err) {
      const limit = await checkRateLimit(deps.redis, ip);
      logger.warn({ err, ip, locked: !limit.ok }, 'crypto: unlock attempt failed');
      await emitAudit(deps.db, {
        action: 'LOGIN',
        entityType: 'firm_key_envelope',
        entityId: state.firmId,
        ip,
        userAgent: req.get('user-agent') ?? null,
        after: { unsealed: false, reason: 'wrong_passphrase_or_corrupt_envelope' },
      });
      if (!limit.ok) {
        res.status(429).json({ error: 'rate_limited', retryAfter: limit.retryAfter });
        return;
      }
      res.status(401).json({ error: 'unlock_failed' });
    }
  });

  // Re-bootstrap is intentionally not exposed via HTTP — it requires
  // direct DB intervention to drop the existing envelope row first.
  // The /unlock endpoint above only bootstraps when state.kind ===
  // 'not-bootstrapped'.

  router.post(
    '/lock',
    deps.requireAuth,
    deps.requireCsrf,
    requirePermission(deps, 'crypto:unlock'),
    async (req: Request, res: Response) => {
      const state = getApplianceLockState();
      if (state.kind !== 'unlocked') {
        res.status(400).json({ error: 'not_unlocked' });
        return;
      }
      const mgr = getFirmKeyManager(deps.db!);
      mgr.forget(state.firmId);
      setApplianceLockState({
        kind: 'locked',
        firmId: state.firmId,
        reason: 'awaiting-passphrase',
      });
      await emitAudit(deps.db, {
        action: 'LOGOUT',
        entityType: 'firm_key_envelope',
        entityId: state.firmId,
        actorAppUserId: req.staffSession?.appUserId ?? null,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
        after: { manuallyLocked: true },
      });
      res.json({ ok: true });
    },
  );

  // Re-key endpoint deferred to Phase K docs procedure; the
  // `crypto:rotate` permission exists in PERMISSION_KEYS for that
  // future endpoint. We don't wire it here because a passphrase change
  // additionally requires re-deriving the KEK and re-wrapping the MFK,
  // which is a separate operational dance from the in-memory rotate.

  // P3.4 — one-way migration: sealed-on-disk → admin-passphrase. Staff
  // auth required; appliance must be unlocked (so we have the live MFK
  // in memory to re-wrap). Permission key `crypto:rotate` because this
  // is an envelope-rewriting operation.
  router.post(
    '/migrate-mode',
    deps.requireAuth,
    deps.requireCsrf,
    requirePermission(deps, 'crypto:rotate'),
    async (req: Request, res: Response) => {
      const state = getApplianceLockState();
      if (state.kind !== 'unlocked') {
        res.status(409).json({ error: 'not_unlocked' });
        return;
      }
      const parsed = MigrateModeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const mgr = getFirmKeyManager(deps.db);
      try {
        const result = await mgr.migrateUnlockMode({
          firmId: state.firmId,
          targetMode: parsed.data.targetMode,
          passphrase: parsed.data.passphrase,
        });
        await deps.db
          .update(firmConfig)
          .set({ unlockMode: 'admin-passphrase' })
          .where(eq(firmConfig.firmId, state.firmId));
        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'firm_key_envelope',
          entityId: state.firmId,
          actorAppUserId: req.staffSession?.appUserId ?? null,
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
          after: {
            migratedTo: 'admin-passphrase',
            rotationVersion: result.rotationVersion,
          },
        });
        logger.info(
          { firmId: state.firmId, rotationVersion: result.rotationVersion },
          'crypto: unlock mode migrated to admin-passphrase',
        );
        res.json({ ok: true, mode: 'admin-passphrase', rotationVersion: result.rotationVersion });
      } catch (err) {
        logger.error({ err, firmId: state.firmId }, 'crypto: migrate-mode failed');
        const message = err instanceof Error ? err.message : 'migrate_failed';
        res.status(400).json({ error: 'migrate_failed', message });
      }
    },
  );

  return router;
}

function serializeState(s: LockState): {
  locked: boolean;
  mode: 'sealed-on-disk' | 'admin-passphrase' | 'unknown';
  reason?: string;
} {
  switch (s.kind) {
    case 'unlocked':
      return { locked: false, mode: 'unknown' };
    case 'locked':
      return { locked: true, mode: 'admin-passphrase', reason: s.reason };
    case 'not-bootstrapped':
      return { locked: true, mode: 'admin-passphrase', reason: 'awaiting-bootstrap' };
    case 'no-firm':
      return { locked: true, mode: 'unknown', reason: 'no-firm' };
  }
}

/**
 * Lock middleware. Returns 503 for every route except the explicit
 * allowlist when the appliance is locked. Mounted before all
 * application routers; health and unlock routes are allowed through so
 * the operator can observe + unlock.
 */
export function createLockMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const s = getApplianceLockState();
    if (s.kind === 'unlocked' || s.kind === 'no-firm') {
      next();
      return;
    }
    // Allowlist: health probes + the unlock surface itself.
    const url = req.path;
    if (
      url === '/health' ||
      url === '/health/db' ||
      url === '/health/redis' ||
      url === '/health/ready' ||
      url === '/metrics' ||
      url.startsWith('/api/staff/admin/unlock') ||
      url === '/api/staff/admin/unlock' ||
      url.startsWith('/api/auth')
    ) {
      next();
      return;
    }
    res.status(503).json({
      error: 'appliance_locked',
      reason: s.kind === 'locked' ? s.reason : 'not-bootstrapped',
    });
  };
}

// Resolve firmConfig.unlockMode at runtime — used by admin/firm-settings
// to surface the mode to the staff UI. Kept here so the unlock module
// owns all crypto-mode queries.
export async function getUnlockMode(
  db: Database | null,
  firmId: string,
): Promise<'sealed-on-disk' | 'admin-passphrase' | null> {
  if (!db) return null;
  const [row] = await db
    .select({ mode: firmConfig.unlockMode })
    .from(firmConfig)
    .where(eq(firmConfig.firmId, firmId))
    .limit(1);
  if (!row) return null;
  return row.mode as 'sealed-on-disk' | 'admin-passphrase';
}
