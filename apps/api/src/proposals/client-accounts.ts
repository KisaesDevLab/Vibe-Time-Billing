// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P18 — Optional client password accounts for the proposal portal.
//
// Clients can convert a magic-link session into a persistent account
// so they don't need a fresh magic link to return to a proposal or
// see future engagements. v1 is email + Argon2id password; TOTP MFA
// is reserved on the schema but not exposed in the UI yet.
//
// Sessions: signed JWT in a cookie. Distinct cookie name
// (__vibe_proposal_client_session) from the existing portal_identity
// session so the two auth realms can't bleed.
//
// Endpoints (all mounted at /api/portal/client-accounts):
//   POST   /register       — magic-link token + email + password →
//                            INSERT client_accounts row + issue cookie
//   POST   /login          — email + password → verify + issue cookie.
//                            Rate-limited 5/15min per (firm, email, IP)
//   POST   /logout         — clear cookie
//   GET    /me             — read cookie + return account
//
// Argon2id is already used in @vibe/crypto for the appliance MFK
// passphrase mode; reuse the same library + a high-but-reasonable
// time-cost preset.

import { createHash } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import type { Redis } from 'ioredis';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SignJWT, jwtVerify } from 'jose';

import type { Database } from '@vibe/db';
import { clientAccounts, magicLinks } from '@vibe/db/schema';
import { hashPassword, verifyPassword } from '@vibe/crypto';

import { emitAudit } from '../auth/audit';
import { logger } from '../logger';

const COOKIE_NAME = '__vibe_proposal_client_session';
const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;

export interface ClientAccountRoutesDeps {
  db: Database | null;
  redis: Redis | null;
  signingKey: string | null;
}

const RegisterSchema = z.object({
  magicLinkToken: z.string().min(20).max(100),
  email: z.string().email().max(240),
  password: z.string().min(10).max(200),
});

const LoginSchema = z.object({
  firmId: z.string().uuid(),
  email: z.string().email().max(240),
  password: z.string().min(1).max(200),
});

function hashMagicLinkToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function signSession(
  key: Uint8Array,
  payload: { aid: string; cid: string; fid: string },
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(key);
}

function writeSessionCookie(res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${TOKEN_TTL_SECONDS}; SameSite=Strict`,
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`);
}

export function createClientAccountRouter(deps: ClientAccountRoutesDeps): Router {
  const router = express.Router();
  const signingKey = deps.signingKey ? new TextEncoder().encode(deps.signingKey) : null;

  router.post('/register', async (req: Request, res: Response) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!deps.db || !signingKey) {
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }
    // Resolve the magic link → firm + client + proposal scope.
    const hash = hashMagicLinkToken(parsed.data.magicLinkToken);
    const [link] = await deps.db
      .select()
      .from(magicLinks)
      .where(eq(magicLinks.tokenHash, hash))
      .limit(1);
    if (!link) {
      res.status(404).json({ error: 'token_not_found' });
      return;
    }
    if (link.expiresAt.getTime() <= Date.now() || link.supersededAt != null) {
      res.status(410).json({ error: 'token_unusable' });
      return;
    }
    if (!link.clientId) {
      res.status(400).json({ error: 'link_not_client_scoped' });
      return;
    }
    const emailLower = parsed.data.email.toLowerCase();
    // Existing account? Login flow handles re-auth — registration is
    // for fresh accounts only.
    const [dupe] = await deps.db
      .select({ id: clientAccounts.id })
      .from(clientAccounts)
      .where(
        and(
          eq(clientAccounts.firmId, link.firmId),
          sql`lower(${clientAccounts.email}) = ${emailLower}`,
        ),
      )
      .limit(1);
    if (dupe) {
      res.status(409).json({ error: 'account_exists' });
      return;
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const [acct] = await deps.db
      .insert(clientAccounts)
      .values({
        firmId: link.firmId,
        clientId: link.clientId,
        email: parsed.data.email,
        passwordHash,
        emailVerifiedAt: new Date(), // magic-link proves email control
      })
      .returning({ id: clientAccounts.id });
    if (!acct) throw new Error('client_account_insert_failed');
    // Stamp client_account_id onto the magic link so future audit
    // can reconstruct the registration provenance.
    await deps.db
      .update(magicLinks)
      .set({ clientAccountId: acct.id })
      .where(eq(magicLinks.id, link.id));
    const jwt = await signSession(signingKey, {
      aid: acct.id,
      cid: link.clientId,
      fid: link.firmId,
    });
    writeSessionCookie(res, jwt);
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'client_account',
      entityId: acct.id,
      after: { email: emailLower, firmId: link.firmId, viaMagicLinkId: link.id },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.status(201).json({ ok: true, clientAccountId: acct.id });
  });

  router.post('/login', async (req: Request, res: Response) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!deps.db || !signingKey) {
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }
    if (deps.redis) {
      const ip = req.ip ?? '0.0.0.0';
      const key = `ca:login:${parsed.data.firmId}:${parsed.data.email.toLowerCase()}:${ip}`;
      const count = await deps.redis.incr(key);
      if (count === 1) await deps.redis.expire(key, LOGIN_WINDOW_SECONDS);
      if (count > LOGIN_MAX_ATTEMPTS) {
        res.status(429).json({ error: 'rate_limited' });
        return;
      }
    }
    const emailLower = parsed.data.email.toLowerCase();
    const [acct] = await deps.db
      .select()
      .from(clientAccounts)
      .where(
        and(
          eq(clientAccounts.firmId, parsed.data.firmId),
          sql`lower(${clientAccounts.email}) = ${emailLower}`,
        ),
      )
      .limit(1);
    // Constant-ish-time response: always verify even when no account
    // exists so timing doesn't reveal account existence.
    const verifyTarget =
      acct?.passwordHash ??
      '$argon2id$v=19$m=65536,t=3,p=1$ZmFrZWZha2VmYWtlZmFrZQ$' +
        'Y2lqaGRrYXNkamthc2RoamFzZGtoamFzZGtqaGFzZGtqaA';
    const ok = await verifyPassword(verifyTarget, parsed.data.password);
    if (!acct || !ok) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    if (acct.lockedUntil && acct.lockedUntil.getTime() > Date.now()) {
      res.status(423).json({ error: 'account_locked' });
      return;
    }
    await deps.db
      .update(clientAccounts)
      .set({ lastLoginAt: new Date(), failedLoginCount: 0 })
      .where(eq(clientAccounts.id, acct.id));
    const jwt = await signSession(signingKey, {
      aid: acct.id,
      cid: acct.clientId,
      fid: acct.firmId,
    });
    writeSessionCookie(res, jwt);
    await emitAudit(deps.db, {
      action: 'LOGIN',
      entityType: 'client_account',
      entityId: acct.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true, clientAccountId: acct.id });
  });

  router.post('/logout', async (_req: Request, res: Response) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', async (req: Request, res: Response) => {
    if (!deps.db || !signingKey) {
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }
    const cookieHeader = req.header('cookie') ?? '';
    const match = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
    if (!match) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const token = match.slice(COOKIE_NAME.length + 1);
    let payload;
    try {
      const v = await jwtVerify(token, signingKey);
      payload = v.payload as { aid?: string; cid?: string; fid?: string };
    } catch {
      res.status(401).json({ error: 'invalid_session' });
      return;
    }
    if (!payload.aid) {
      res.status(401).json({ error: 'invalid_session' });
      return;
    }
    const [acct] = await deps.db
      .select({
        id: clientAccounts.id,
        firmId: clientAccounts.firmId,
        clientId: clientAccounts.clientId,
        email: clientAccounts.email,
        emailVerifiedAt: clientAccounts.emailVerifiedAt,
        lastLoginAt: clientAccounts.lastLoginAt,
      })
      .from(clientAccounts)
      .where(eq(clientAccounts.id, payload.aid))
      .limit(1);
    if (!acct) {
      res.status(401).json({ error: 'account_not_found' });
      return;
    }
    res.json({ account: acct });
  });

  return router;
}
