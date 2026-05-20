// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client portal authentication routes.
// - Email path → magic link signed with PORTAL_JWT_SECRET (distinct from staff)
// - Phone path → SMS OTP (6 digits, 5-minute TTL)
// - Active-client switcher uses the session's `active_client_id`.

import express, { type Request, type Response, type Router } from 'express';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import {
  checkAndIncrement,
  detectLoginKind,
  generateCsrfToken,
  generateSessionId,
  generateSmsOtp,
  hashSmsOtp,
  issueMagicLink,
  normalizePhone,
  randomNonce,
  verifyMagicLink,
  type PortalSession,
} from '@vibe/core/auth';
import type { Database } from '@vibe/db';
import { clientPortalAccess, portalIdentity } from '@vibe/db/schema';

import { loadConfig } from '../config';
import { logger } from '../logger';
import { emitAudit } from './audit';
import { clearSessionCookie, writeSessionCookie } from './cookies';
import type { SessionStore } from './session-store';

export interface PortalRoutesDeps {
  db: Database | null;
  redis: Redis;
  sessionStore: SessionStore;
  sendEmail: (args: { to: string; subject: string; body: string }) => Promise<void>;
  sendSms: (args: { to: string; body: string }) => Promise<void>;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

const LoginSchema = z.object({ contact: z.string().min(3).max(254) });
const VerifyMagicSchema = z.object({ token: z.string().min(1) });
const VerifyOtpSchema = z.object({ phone: z.string().min(5), code: z.string().regex(/^\d{6}$/) });
const SwitchClientSchema = z.object({ clientId: z.string().uuid() });

const GENERIC_RESPONSE = {
  ok: true,
  message: 'If your account exists, a sign-in code has been sent.',
};

export function createPortalAuthRouter(deps: PortalRoutesDeps): Router {
  const router = express.Router();

  router.post('/login', async (req: Request, res: Response) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const cfg = loadConfig();
    const kind = detectLoginKind(parsed.data.contact);
    const ip = clientIp(req);

    // Rate limits — Q29.
    const ipLimit = await checkAndIncrement(deps.redis, {
      key: `rl:portal:login:ip:${ip}`,
      windowSeconds: 15 * 60,
      max: 20,
    });
    if (!ipLimit.allowed) {
      res.status(200).json(GENERIC_RESPONSE);
      return;
    }

    if (kind === 'email') {
      const email = parsed.data.contact.toLowerCase();
      const cl = await checkAndIncrement(deps.redis, {
        key: `rl:portal:login:contact:${email}`,
        windowSeconds: 15 * 60,
        max: 5,
      });
      if (!cl.allowed) {
        res.status(200).json(GENERIC_RESPONSE);
        return;
      }
      const id = await findIdentityByEmail(deps.db, email);
      if (id) {
        const nonce = randomNonce();
        const token = await issueMagicLink({
          subjectId: id.id,
          firmId: id.firmId,
          realm: 'portal',
          signingKey: new TextEncoder().encode(cfg.PORTAL_JWT_SECRET),
          ttlSeconds: cfg.MAGIC_LINK_TTL_MINUTES * 60,
          nonce,
        });
        await deps.redis.set(
          `magic-link:nonce:portal:${nonce}`,
          '1',
          'EX',
          cfg.MAGIC_LINK_TTL_MINUTES * 60,
        );
        const link = `${cfg.PORTAL_BASE_URL}/auth/verify?token=${encodeURIComponent(token)}`;
        await deps
          .sendEmail({ to: email, subject: 'Your sign-in link', body: link })
          .catch((err: unknown) => logger.error({ err }, 'portal magic-link delivery'));
      }
      res.status(200).json(GENERIC_RESPONSE);
      return;
    }

    if (kind === 'phone') {
      const phone = normalizePhone(parsed.data.contact);
      if (!phone) {
        res.status(200).json(GENERIC_RESPONSE);
        return;
      }
      const cl = await checkAndIncrement(deps.redis, {
        key: `rl:portal:login:contact:${phone}`,
        windowSeconds: 15 * 60,
        max: 5,
      });
      if (!cl.allowed) {
        res.status(200).json(GENERIC_RESPONSE);
        return;
      }
      const id = await findIdentityByPhone(deps.db, phone);
      if (id) {
        const code = generateSmsOtp();
        await deps.redis.set(
          `portal:otp:${phone}`,
          JSON.stringify({ hash: hashSmsOtp(code), identityId: id.id, attempts: 0 }),
          'EX',
          cfg.SMS_OTP_TTL_MINUTES * 60,
        );
        await deps
          .sendSms({ to: phone, body: `Your Vibe sign-in code: ${code}` })
          .catch((err: unknown) => logger.error({ err }, 'portal sms delivery'));
      }
      res.status(200).json(GENERIC_RESPONSE);
      return;
    }

    // Unknown kind — same generic response.
    res.status(200).json(GENERIC_RESPONSE);
  });

  router.post('/verify-magic-link', async (req: Request, res: Response) => {
    const parsed = VerifyMagicSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const cfg = loadConfig();
    let payload;
    try {
      payload = await verifyMagicLink({
        token: parsed.data.token,
        realm: 'portal',
        signingKey: new TextEncoder().encode(cfg.PORTAL_JWT_SECRET),
      });
    } catch {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    const deleted = await deps.redis.del(`magic-link:nonce:portal:${payload.nce}`);
    if (deleted === 0) {
      res.status(401).json({ error: 'token_already_used' });
      return;
    }
    await issueSession(deps, res, req, payload.sub, payload.fid);
  });

  router.post('/verify-sms-otp', async (req: Request, res: Response) => {
    const parsed = VerifyOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const phone = normalizePhone(parsed.data.phone);
    if (!phone) {
      res.status(401).json({ error: 'invalid_phone' });
      return;
    }
    const raw = await deps.redis.get(`portal:otp:${phone}`);
    if (!raw) {
      res.status(401).json({ error: 'no_pending_otp' });
      return;
    }
    const state = JSON.parse(raw) as { hash: string; identityId: string; attempts: number };
    state.attempts += 1;
    if (state.attempts > 5) {
      await deps.redis.del(`portal:otp:${phone}`);
      res.status(429).json({ error: 'too_many_attempts' });
      return;
    }
    if (hashSmsOtp(parsed.data.code) !== state.hash) {
      await deps.redis.set(`portal:otp:${phone}`, JSON.stringify(state), 'KEEPTTL');
      res.status(401).json({ error: 'invalid_code' });
      return;
    }
    await deps.redis.del(`portal:otp:${phone}`);
    // Mark phone verified at this point — Q6 first-use verification.
    if (deps.db) {
      await deps.db
        .update(portalIdentity)
        .set({ primaryPhoneVerifiedAt: new Date() })
        .where(eq(portalIdentity.id, state.identityId));
    }
    const identity = await findIdentityById(deps.db, state.identityId);
    if (!identity) {
      res.status(401).json({ error: 'unknown_identity' });
      return;
    }
    await issueSession(deps, res, req, identity.id, identity.firmId);
  });

  router.post('/switch-client', deps.requireAuth, async (req: Request, res: Response) => {
    const parsed = SwitchClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.portalSession!;
    if (deps.db) {
      const [access] = await deps.db
        .select({ id: clientPortalAccess.id })
        .from(clientPortalAccess)
        .where(
          and(
            eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
            eq(clientPortalAccess.clientId, parsed.data.clientId),
            eq(clientPortalAccess.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (!access) {
        res.status(403).json({ error: 'no_access' });
        return;
      }
    }
    session.activeClientId = parsed.data.clientId;
    await deps.sessionStore.put(session);
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'portal_session',
      entityId: null,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: parsed.data.clientId,
      after: { activeClientId: parsed.data.clientId },
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true, activeClientId: parsed.data.clientId });
  });

  router.post('/logout', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (session) {
      await deps.sessionStore.destroy('portal', session.sid);
    }
    clearSessionCookie(res, 'portal');
    res.json({ ok: true });
  });

  router.get('/me', deps.requireAuth, (req: Request, res: Response) => {
    const s = req.portalSession!;
    res.json({
      portalIdentityId: s.portalIdentityId,
      firmId: s.firmId,
      activeClientId: s.activeClientId,
      csrfToken: s.csrfToken,
    });
  });

  return router;
}

async function issueSession(
  deps: PortalRoutesDeps,
  res: Response,
  req: Request,
  identityId: string,
  firmId: string,
): Promise<void> {
  // Default active client = first active access; require at least one.
  let activeClientId: string | null = null;
  if (deps.db) {
    const [first] = await deps.db
      .select({ clientId: clientPortalAccess.clientId })
      .from(clientPortalAccess)
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, identityId),
          eq(clientPortalAccess.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    activeClientId = first?.clientId ?? null;
  }
  if (!activeClientId) {
    res.status(403).json({ error: 'no_client_access' });
    return;
  }
  const session: PortalSession = {
    realm: 'portal',
    sid: generateSessionId(),
    portalIdentityId: identityId,
    firmId,
    activeClientId,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    csrfToken: generateCsrfToken(),
    ip: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
  };
  await deps.sessionStore.put(session);
  writeSessionCookie(res, 'portal', session.sid);

  await emitAudit(deps.db, {
    action: 'LOGIN',
    entityType: 'portal_identity',
    entityId: identityId,
    actorPortalIdentityId: identityId,
    activeClientId,
    ip: session.ip,
    userAgent: session.userAgent,
  }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

  res.json({
    ok: true,
    csrfToken: session.csrfToken,
    activeClientId,
  });
}

async function findIdentityByEmail(
  db: Database | null,
  email: string,
): Promise<{ id: string; firmId: string } | null> {
  if (!db) return null;
  const [row] = await db
    .select({ id: portalIdentity.id, firmId: portalIdentity.firmId })
    .from(portalIdentity)
    .where(eq(portalIdentity.primaryEmail, email))
    .limit(1);
  return row ?? null;
}

async function findIdentityByPhone(
  db: Database | null,
  phone: string,
): Promise<{ id: string; firmId: string } | null> {
  if (!db) return null;
  const [row] = await db
    .select({ id: portalIdentity.id, firmId: portalIdentity.firmId })
    .from(portalIdentity)
    .where(eq(portalIdentity.primaryPhone, phone))
    .limit(1);
  return row ?? null;
}

async function findIdentityById(
  db: Database | null,
  id: string,
): Promise<{ id: string; firmId: string } | null> {
  if (!db) return null;
  const [row] = await db
    .select({ id: portalIdentity.id, firmId: portalIdentity.firmId })
    .from(portalIdentity)
    .where(eq(portalIdentity.id, id))
    .limit(1);
  return row ?? null;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
