// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-3 — "remember this device" for the Tauri desktop shell.
//
// The browser keeps cookie sessions (SESSION_TTL_SECONDS, sliding). The
// desktop app lives in the tray for weeks, so it gets one extra primitive:
// a device-bound refresh credential that can mint a fresh cookie session
// on launch. Properties:
//
//   - Opaque 256-bit token; only its SHA-256 is stored (Redis), alongside
//     {appUserId, firmId, deviceId, deviceName, createdAt, lastUsedAt}.
//   - Bound to a deviceId the shell generates once and keeps in the OS
//     credential store next to the token; both must match on refresh.
//   - Rotated on every use (old hash deleted, new token returned). A replay
//     of a rotated token revokes the whole device — that is the standard
//     refresh-token-theft tell.
//   - Sessions minted this way start with lastStepUpAt = null, so every
//     step-up-gated action still asks for a factor. Remembering the device
//     never weakens the sensitive paths.
//   - Revocable: by the user (Account → Desktop), by anyone with
//     app_user:write (admin), and implicitly when the user is archived.
//
// Mounted twice from app.ts:
//   /api/auth/desktop/*             enroll (authed+CSRF), refresh (public)
//   /api/staff/desktop/devices/*    list / revoke own; admin list / revoke
//
// Keys:  vibe:desktop:cred:<hash>        JSON record, EX DESKTOP_CRED_TTL
//        vibe:desktop:user:<appUserId>   SET of hashes

import { createHash, randomBytes } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { appUsers } from '@vibe/db/schema';
import { generateCsrfToken, generateSessionId, type StaffSession } from '@vibe/core/auth';

import { emitAudit } from './audit';
import { writeSessionCookie } from './cookies';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import type { SessionStore } from './session-store';
import { logger } from '../logger';

export const DESKTOP_CRED_TTL_SECONDS = 90 * 24 * 3600;
const MAX_DEVICES_PER_USER = 5;

const CRED_PREFIX = 'vibe:desktop:cred:';
const USER_PREFIX = 'vibe:desktop:user:';

export interface DesktopDeviceRecord {
  appUserId: string;
  firmId: string;
  deviceId: string;
  deviceName: string;
  createdAt: number;
  lastUsedAt: number;
  lastIp: string | null;
}

export interface DesktopDeviceView {
  id: string; // hash prefix, safe to show + use for revoke
  deviceId: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string;
  lastIp: string | null;
}

export interface DesktopDevicesDeps extends RbacDeps {
  db: Database | null;
  redis: Redis;
  sessionStore: SessionStore;
}

const DeviceIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const EnrollSchema = z.object({
  deviceId: DeviceIdSchema,
  deviceName: z.string().min(1).max(120),
});

const RefreshSchema = z.object({
  deviceId: DeviceIdSchema,
  refreshToken: z.string().min(32).max(256),
});

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

function toView(hash: string, rec: DesktopDeviceRecord): DesktopDeviceView {
  return {
    id: hash.slice(0, 16),
    deviceId: rec.deviceId,
    deviceName: rec.deviceName,
    createdAt: new Date(rec.createdAt).toISOString(),
    lastUsedAt: new Date(rec.lastUsedAt).toISOString(),
    lastIp: rec.lastIp,
  };
}

export class DesktopDeviceStore {
  constructor(private readonly redis: Redis) {}

  async put(hash: string, rec: DesktopDeviceRecord): Promise<void> {
    await this.redis.set(CRED_PREFIX + hash, JSON.stringify(rec), 'EX', DESKTOP_CRED_TTL_SECONDS);
    await this.redis.sadd(USER_PREFIX + rec.appUserId, hash);
    await this.redis.expire(USER_PREFIX + rec.appUserId, DESKTOP_CRED_TTL_SECONDS);
  }

  async get(hash: string): Promise<DesktopDeviceRecord | null> {
    const raw = await this.redis.get(CRED_PREFIX + hash);
    return raw ? (JSON.parse(raw) as DesktopDeviceRecord) : null;
  }

  async del(hash: string, appUserId: string): Promise<void> {
    await this.redis.del(CRED_PREFIX + hash);
    await this.redis.srem(USER_PREFIX + appUserId, hash);
  }

  /** All live devices for a user; prunes expired hashes from the index. */
  async list(appUserId: string): Promise<Array<{ hash: string; rec: DesktopDeviceRecord }>> {
    const hashes = await this.redis.smembers(USER_PREFIX + appUserId);
    const out: Array<{ hash: string; rec: DesktopDeviceRecord }> = [];
    for (const h of hashes) {
      const rec = await this.get(h);
      if (rec) out.push({ hash: h, rec });
      else await this.redis.srem(USER_PREFIX + appUserId, h);
    }
    out.sort((a, b) => b.rec.lastUsedAt - a.rec.lastUsedAt);
    return out;
  }

  async revokeAll(appUserId: string): Promise<number> {
    const items = await this.list(appUserId);
    for (const it of items) await this.del(it.hash, appUserId);
    return items.length;
  }

  /** Find a device record by its public id (hash prefix). */
  async findByPublicId(
    appUserId: string,
    publicId: string,
  ): Promise<{ hash: string; rec: DesktopDeviceRecord } | null> {
    const items = await this.list(appUserId);
    return items.find((it) => it.hash.startsWith(publicId)) ?? null;
  }
}

/** Public (pre-auth) + authed enrollment endpoints → mount under /api/auth. */
export function createDesktopAuthRouter(
  deps: DesktopDevicesDeps & {
    requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
    requireCsrf?: (req: Request, res: Response, next: () => void) => void;
  },
): Router {
  const router = express.Router();
  const store = new DesktopDeviceStore(deps.redis);
  const csrf = deps.requireCsrf ?? ((_r: Request, _s: Response, n: () => void) => n());

  // POST /desktop/enroll — the signed-in shell asks to be remembered.
  router.post('/desktop/enroll', deps.requireAuth, csrf, async (req: Request, res: Response) => {
    const parsed = EnrollSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.staffSession!;
    const existing = await store.list(session.appUserId);
    // Re-enrolling the same device replaces its credential.
    for (const it of existing) {
      if (it.rec.deviceId === parsed.data.deviceId) await store.del(it.hash, session.appUserId);
    }
    if ((await store.list(session.appUserId)).length >= MAX_DEVICES_PER_USER) {
      res.status(409).json({ error: 'too_many_devices', max: MAX_DEVICES_PER_USER });
      return;
    }
    const token = newToken();
    const now = Date.now();
    await store.put(hashToken(token), {
      appUserId: session.appUserId,
      firmId: session.firmId,
      deviceId: parsed.data.deviceId,
      deviceName: parsed.data.deviceName,
      createdAt: now,
      lastUsedAt: now,
      lastIp: clientIp(req),
    });
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'desktop_device',
      entityId: session.appUserId,
      actorAppUserId: session.appUserId,
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
      after: { deviceId: parsed.data.deviceId, deviceName: parsed.data.deviceName },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.status(201).json({
      refreshToken: token,
      expiresAt: new Date(now + DESKTOP_CRED_TTL_SECONDS * 1000).toISOString(),
    });
  });

  // POST /desktop/refresh — mint a cookie session from a device credential.
  // Public: the caller has no session yet. Rotates the token.
  router.post('/desktop/refresh', async (req: Request, res: Response) => {
    const parsed = RefreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const hash = hashToken(parsed.data.refreshToken);
    const rec = await store.get(hash);
    if (!rec || rec.deviceId !== parsed.data.deviceId) {
      // Constant-ish response for unknown/mismatched tokens.
      res.status(401).json({ error: 'invalid_device_credential' });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [user] = await deps.db
      .select({ id: appUsers.id, firmId: appUsers.firmId, status: appUsers.status })
      .from(appUsers)
      .where(eq(appUsers.id, rec.appUserId))
      .limit(1);
    if (!user || user.status !== 'ACTIVE') {
      await store.revokeAll(rec.appUserId);
      res.status(401).json({ error: 'invalid_device_credential' });
      return;
    }

    // Rotate first so a crash between steps can only cost a re-login.
    const nextToken = newToken();
    const now = Date.now();
    await store.del(hash, rec.appUserId);
    await store.put(hashToken(nextToken), {
      ...rec,
      lastUsedAt: now,
      lastIp: clientIp(req),
    });

    const session: StaffSession = {
      realm: 'staff',
      sid: generateSessionId(),
      appUserId: user.id,
      firmId: user.firmId,
      createdAt: now,
      lastSeenAt: now,
      // Never stepped-up: sensitive actions still ask for a factor.
      lastStepUpAt: null,
      csrfToken: generateCsrfToken(),
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    };
    await deps.sessionStore.put(session);
    writeSessionCookie(res, 'staff', session.sid);
    await emitAudit(deps.db, {
      action: 'LOGIN',
      entityType: 'app_user',
      entityId: user.id,
      actorAppUserId: user.id,
      ip: session.ip,
      userAgent: session.userAgent,
      after: { source: 'desktop', deviceId: rec.deviceId },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.status(200).json({
      ok: true,
      csrfToken: session.csrfToken,
      refreshToken: nextToken,
      expiresAt: new Date(now + DESKTOP_CRED_TTL_SECONDS * 1000).toISOString(),
    });
  });

  return router;
}

/** Authed device management → mount under /api/staff/desktop/devices. */
export function createDesktopDevicesRouter(deps: DesktopDevicesDeps): Router {
  const router = express.Router();
  const store = new DesktopDeviceStore(deps.redis);

  // GET / — my devices.
  router.get('/', async (req: Request, res: Response) => {
    const session = req.staffSession!;
    const items = await store.list(session.appUserId);
    res.json({ items: items.map((it) => toView(it.hash, it.rec)) });
  });

  // DELETE /:id — revoke one of mine.
  router.delete('/:id', async (req: Request, res: Response) => {
    const session = req.staffSession!;
    const found = await store.findByPublicId(session.appUserId, String(req.params['id']));
    if (!found) {
      res.status(404).json({ error: 'device_not_found' });
      return;
    }
    await store.del(found.hash, session.appUserId);
    res.json({ ok: true });
  });

  // GET /user/:appUserId — admin view of someone else's devices.
  router.get(
    '/user/:appUserId',
    requirePermission(deps, 'app_user:write'),
    async (req: Request, res: Response) => {
      const target = String(req.params['appUserId']);
      if (!(await sameFirm(deps.db, req.staffSession!.firmId, target))) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }
      const items = await store.list(target);
      res.json({ items: items.map((it) => toView(it.hash, it.rec)) });
    },
  );

  // DELETE /user/:appUserId — admin revoke-all for a user.
  router.delete(
    '/user/:appUserId',
    requirePermission(deps, 'app_user:write'),
    async (req: Request, res: Response) => {
      const target = String(req.params['appUserId']);
      if (!(await sameFirm(deps.db, req.staffSession!.firmId, target))) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }
      const n = await store.revokeAll(target);
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'desktop_device',
        entityId: target,
        actorAppUserId: req.staffSession!.appUserId,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        after: { revoked: n },
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, revoked: n });
    },
  );

  return router;
}

async function sameFirm(db: Database | null, firmId: string, appUserId: string): Promise<boolean> {
  if (!db) return false;
  if (!/^[0-9a-f-]{36}$/i.test(appUserId)) return false;
  const [row] = await db
    .select({ firmId: appUsers.firmId })
    .from(appUsers)
    .where(eq(appUsers.id, appUserId))
    .limit(1);
  return !!row && row.firmId === firmId;
}
