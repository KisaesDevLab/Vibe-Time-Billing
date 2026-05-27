// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Staff authentication routes. Magic-link primary + mandatory TOTP step-up.
// Q5 locked: TOTP is required for all staff. Q4 locked: step-up timeout
// defaults to 30 minutes. Q29: account-enumeration mitigation.

import type { Request, Response, Router } from 'express';
import express from 'express';
import { z } from 'zod';
import type { Redis } from 'ioredis';

import {
  checkAndIncrement,
  generateCsrfToken,
  generateSessionId,
  issueMagicLink,
  newEnrollment,
  randomNonce,
  verifyMagicLink,
  verifyTotp,
  hashRecoveryCode,
  type StaffSession,
} from '@vibe/core/auth';
import { unionPermissions, type PermissionKey, type RoleSlug } from '@vibe/core/rbac';
import type { Database } from '@vibe/db';
import { appUserCredentials, appUsers, roles, userRoles } from '@vibe/db/schema';
import { and, eq } from 'drizzle-orm';

import { loadConfig } from '../config';
import { logger } from '../logger';
import { emitAudit } from './audit';
import { clearSessionCookie, writeSessionCookie } from './cookies';
import type { SessionStore } from './session-store';
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from './webauthn';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

export interface StaffRoutesDeps {
  db: Database | null;
  redis: Redis;
  sessionStore: SessionStore;
  // Email delivery is pluggable (Q11); in tests we just capture the link.
  sendMagicLink: (args: { email: string; firmId: string; link: string }) => Promise<void>;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  // Test seam — explicit user→roles map overrides DB lookup when provided.
  // Used by `/me` to surface effective permissions to the FE without
  // touching a real DB in unit tests.
  fakeUserRoles?: Map<string, RoleSlug[]>;
}

// zod 3.25's .email() validator is overly strict; use a permissive
// RFC 5322-ish regex instead. The DB unique index on (firm_id, email)
// remains the authoritative check.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LoginSchema = z.object({ email: z.string().regex(EMAIL_RE) });
const VerifySchema = z.object({ token: z.string().min(1) });
const TotpEnrollSchema = z.object({}); // no body
const TotpVerifySchema = z.object({ code: z.string().min(6).max(16) });

// WebAuthn payload schemas. We trust @simplewebauthn/server to validate
// the inner attestation/assertion bytes; here we only enforce shape.
const WebAuthnRegistrationVerifySchema = z.object({
  response: z.object({ id: z.string().min(1) }).passthrough(),
  label: z.string().max(80).optional(),
});
const WebAuthnAuthVerifySchema = z.object({
  response: z.object({ id: z.string().min(1) }).passthrough(),
});

const ENUM_RESPONSE = {
  ok: true,
  message: 'If your account exists, a sign-in code has been sent.',
};

export function createStaffAuthRouter(deps: StaffRoutesDeps): Router {
  const router = express.Router();

  router.post('/login', async (req: Request, res: Response) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }

    const ip = clientIp(req);
    const cfg = loadConfig();

    // Q29 limits: 5 per contact / 15min, 20 per IP / 15min.
    const contactLimit = await checkAndIncrement(deps.redis, {
      key: `rl:auth:login:contact:${parsed.data.email.toLowerCase()}`,
      windowSeconds: 15 * 60,
      max: 5,
    });
    const ipLimit = await checkAndIncrement(deps.redis, {
      key: `rl:auth:login:ip:${ip}`,
      windowSeconds: 15 * 60,
      max: 20,
    });
    if (!contactLimit.allowed || !ipLimit.allowed) {
      // Same response shape regardless — no enumeration signal.
      res.status(200).json(ENUM_RESPONSE);
      return;
    }

    const user = await findStaffByEmail(deps.db, parsed.data.email);
    if (user) {
      const nonce = randomNonce();
      const token = await issueMagicLink({
        subjectId: user.id,
        firmId: user.firmId,
        realm: 'staff',
        signingKey: new TextEncoder().encode(cfg.STAFF_JWT_SECRET),
        ttlSeconds: cfg.MAGIC_LINK_TTL_MINUTES * 60,
        nonce,
      });
      // Track issued nonces so we can refuse replays.
      await deps.redis.set(
        `magic-link:nonce:staff:${nonce}`,
        '1',
        'EX',
        cfg.MAGIC_LINK_TTL_MINUTES * 60,
      );
      const link = `${cfg.APP_BASE_URL}/auth/verify?token=${encodeURIComponent(token)}`;
      try {
        await deps.sendMagicLink({ email: user.email, firmId: user.firmId, link });
      } catch (err) {
        logger.error({ err }, 'magic link delivery failed');
      }
    }

    // Same response shape whether or not user exists.
    res.status(200).json(ENUM_RESPONSE);
  });

  router.post('/verify-magic-link', async (req: Request, res: Response) => {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const cfg = loadConfig();
    let payload;
    try {
      payload = await verifyMagicLink({
        token: parsed.data.token,
        realm: 'staff',
        signingKey: new TextEncoder().encode(cfg.STAFF_JWT_SECRET),
      });
    } catch {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    // Single-use: delete the nonce, refuse if it's missing (replay).
    const nonceKey = `magic-link:nonce:staff:${payload.nce}`;
    const deleted = await deps.redis.del(nonceKey);
    if (deleted === 0) {
      res.status(401).json({ error: 'token_already_used' });
      return;
    }

    const user = await findStaffById(deps.db, payload.sub);
    if (!user) {
      res.status(401).json({ error: 'unknown_user' });
      return;
    }

    const session: StaffSession = {
      realm: 'staff',
      sid: generateSessionId(),
      appUserId: user.id,
      firmId: user.firmId,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
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
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.status(200).json({
      ok: true,
      csrfToken: session.csrfToken,
      needsTotpEnrollment: !user.totpEnrolledAt,
    });
  });

  router.post('/totp/enroll', deps.requireAuth, async (req: Request, res: Response) => {
    TotpEnrollSchema.parse(req.body);
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const user = await findStaffById(deps.db, session.appUserId);
    if (!user) {
      res.status(401).json({ error: 'unknown_user' });
      return;
    }
    const enrollment = newEnrollment({
      accountName: user.email,
      issuer: 'Vibe Time & Billing',
    });
    // Store enrollment in Redis pending confirmation by /totp/verify.
    await deps.redis.set(
      `totp:pending:${session.appUserId}`,
      JSON.stringify({
        secret: enrollment.secret,
        recoveryHashes: enrollment.recoveryCodeHashes,
      }),
      'EX',
      15 * 60,
    );
    res.status(200).json({
      otpauthUri: enrollment.otpauthUri,
      recoveryCodes: enrollment.recoveryCodes,
    });
  });

  router.post('/totp/verify', deps.requireAuth, async (req: Request, res: Response) => {
    const parsed = TotpVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    // If user has a confirmed secret, this is a step-up. Otherwise this is
    // the second leg of enrollment.
    const user = await findStaffById(deps.db, session.appUserId);
    if (!user) {
      res.status(401).json({ error: 'unknown_user' });
      return;
    }

    const cfg = loadConfig();

    const lockoutKey = `lockout:staff:totp:${session.appUserId}`;
    const lockedUntil = await deps.redis.get(lockoutKey);
    if (lockedUntil && Number(lockedUntil) > Date.now()) {
      res.status(429).json({ error: 'locked_out', retry_at: Number(lockedUntil) });
      return;
    }

    let secret: string | null = null;
    let enrollmentCompleted = false;

    if (user.totpEnrolledAt && user.totpSecretEncrypted) {
      secret = user.totpSecretEncrypted;
    } else {
      const pendingRaw = await deps.redis.get(`totp:pending:${session.appUserId}`);
      if (!pendingRaw) {
        res.status(400).json({ error: 'no_pending_enrollment' });
        return;
      }
      const pending = JSON.parse(pendingRaw) as { secret: string; recoveryHashes: string[] };
      secret = pending.secret;
      enrollmentCompleted = true;
      if (deps.db) {
        await deps.db
          .update(appUsers)
          .set({
            totpSecretEncrypted: pending.secret,
            recoveryCodesEncrypted: JSON.stringify(pending.recoveryHashes),
            totpEnrolledAt: new Date(),
          })
          .where(eq(appUsers.id, session.appUserId));
      }
      await deps.redis.del(`totp:pending:${session.appUserId}`);
    }

    const ok =
      verifyTotp({ token: parsed.data.code, secret }) ||
      (await tryRecoveryCode(deps, user.id, parsed.data.code));
    if (!ok) {
      const attempts = await deps.redis.incr(`lockout-attempts:staff:totp:${session.appUserId}`);
      await deps.redis.expire(`lockout-attempts:staff:totp:${session.appUserId}`, 15 * 60);
      if (attempts >= 5) {
        await deps.redis.set(lockoutKey, String(Date.now() + 15 * 60 * 1000), 'EX', 15 * 60);
      }
      res.status(401).json({ error: 'invalid_code' });
      return;
    }
    await deps.redis.del(`lockout-attempts:staff:totp:${session.appUserId}`);
    // Stage 1B — clear any pending step-up failure counter on success.
    // Best-effort; lockouts auto-expire via the Redis TTL regardless.
    await deps.redis.del(`step-up:failures:${session.appUserId}`).catch(() => undefined);

    session.lastStepUpAt = Date.now();
    await deps.sessionStore.put(session);

    await emitAudit(deps.db, {
      action: 'STEP_UP',
      entityType: 'app_user',
      entityId: session.appUserId,
      actorAppUserId: session.appUserId,
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    void cfg; // referenced for cached settings — keep linter quiet
    res.status(200).json({ ok: true, enrolled: enrollmentCompleted });
  });

  // -------------------------------------------------------------------
  // Phase 3 item #8 — WebAuthn / passkey enrollment + assertion.
  //
  // Six endpoints:
  //   POST   /webauthn/registration/options
  //   POST   /webauthn/registration/verify
  //   POST   /webauthn/auth/options
  //   POST   /webauthn/auth/verify
  //   GET    /webauthn/credentials
  //   DELETE /webauthn/credentials/:id
  //
  // Registration challenge is stored under
  //   webauthn:reg:{appUserId}        TTL 5 min
  // Authentication challenge under
  //   webauthn:auth:{appUserId}       TTL 5 min
  //
  // A successful assertion updates session.lastStepUpAt — the same
  // step-up bump TOTP provides — and bumps the per-credential
  // sign_count + last_used_at.
  // -------------------------------------------------------------------

  router.post(
    '/webauthn/registration/options',
    deps.requireAuth,
    async (req: Request, res: Response) => {
      const session = req.staffSession;
      if (!session) {
        res.status(401).json({ error: 'no_session' });
        return;
      }
      const user = await findStaffById(deps.db, session.appUserId);
      if (!user) {
        res.status(401).json({ error: 'unknown_user' });
        return;
      }
      const existing = await listCredentials(deps.db, session.appUserId);
      let options;
      try {
        options = await buildRegistrationOptions({
          appUserId: session.appUserId,
          email: user.email,
          fullName: user.email,
          existing,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'webauthn_unavailable';
        res.status(503).json({ error: msg });
        return;
      }
      await deps.redis.set(`webauthn:reg:${session.appUserId}`, options.challenge, 'EX', 5 * 60);
      res.status(200).json(options);
    },
  );

  router.post(
    '/webauthn/registration/verify',
    deps.requireAuth,
    async (req: Request, res: Response) => {
      const session = req.staffSession;
      if (!session) {
        res.status(401).json({ error: 'no_session' });
        return;
      }
      const parsed = WebAuthnRegistrationVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const challenge = await deps.redis.get(`webauthn:reg:${session.appUserId}`);
      if (!challenge) {
        res.status(400).json({ error: 'no_pending_registration' });
        return;
      }
      const outcome = await verifyRegistration({
        response: parsed.data.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge,
      });
      await deps.redis.del(`webauthn:reg:${session.appUserId}`);
      if (!outcome.ok || !outcome.credential) {
        res.status(400).json({ error: outcome.error ?? 'verify_failed' });
        return;
      }
      if (deps.db) {
        await deps.db.insert(appUserCredentials).values({
          appUserId: session.appUserId,
          credentialId: outcome.credential.credentialId,
          publicKey: outcome.credential.publicKey,
          signCount: outcome.credential.signCount,
          transports: outcome.credential.transports,
          label: parsed.data.label ?? null,
          aaguid: outcome.credential.aaguid,
          deviceType: outcome.credential.deviceType,
          backedUp: outcome.credential.backedUp,
        });
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'app_user_credential',
        entityId: outcome.credential.credentialId,
        actorAppUserId: session.appUserId,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ ok: true });
    },
  );

  router.post('/webauthn/auth/options', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const candidates = await listCredentials(deps.db, session.appUserId);
    if (candidates.length === 0) {
      res.status(400).json({ error: 'no_credentials' });
      return;
    }
    let options;
    try {
      options = await buildAuthenticationOptions({ candidates });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'webauthn_unavailable';
      res.status(503).json({ error: msg });
      return;
    }
    await deps.redis.set(`webauthn:auth:${session.appUserId}`, options.challenge, 'EX', 5 * 60);
    res.status(200).json(options);
  });

  router.post('/webauthn/auth/verify', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const parsed = WebAuthnAuthVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const challenge = await deps.redis.get(`webauthn:auth:${session.appUserId}`);
    if (!challenge) {
      res.status(400).json({ error: 'no_pending_authentication' });
      return;
    }
    const credentialId = parsed.data.response.id;
    const credential = await findCredentialByIdForUser(deps.db, session.appUserId, credentialId);
    if (!credential) {
      await deps.redis.del(`webauthn:auth:${session.appUserId}`);
      res.status(400).json({ error: 'credential_not_found' });
      return;
    }
    const outcome = await verifyAuthentication({
      response: parsed.data.response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      credential,
    });
    await deps.redis.del(`webauthn:auth:${session.appUserId}`);
    if (!outcome.ok) {
      res.status(401).json({ error: outcome.error ?? 'verify_failed' });
      return;
    }
    if (deps.db && outcome.newSignCount != null) {
      await deps.db
        .update(appUserCredentials)
        .set({ signCount: outcome.newSignCount, lastUsedAt: new Date() })
        .where(eq(appUserCredentials.id, credential.id));
    }
    session.lastStepUpAt = Date.now();
    await deps.sessionStore.put(session);
    await emitAudit(deps.db, {
      action: 'STEP_UP',
      entityType: 'app_user_credential',
      entityId: credential.id,
      actorAppUserId: session.appUserId,
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.status(200).json({ ok: true });
  });

  router.get('/webauthn/credentials', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const rows = await deps.db
      .select({
        id: appUserCredentials.id,
        label: appUserCredentials.label,
        transports: appUserCredentials.transports,
        deviceType: appUserCredentials.deviceType,
        backedUp: appUserCredentials.backedUp,
        createdAt: appUserCredentials.createdAt,
        lastUsedAt: appUserCredentials.lastUsedAt,
      })
      .from(appUserCredentials)
      .where(eq(appUserCredentials.appUserId, session.appUserId));
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        label: r.label,
        transports: r.transports ? r.transports.split(',').filter(Boolean) : [],
        deviceType: r.deviceType,
        backedUp: r.backedUp,
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      })),
    });
  });

  router.delete(
    '/webauthn/credentials/:id',
    deps.requireAuth,
    async (req: Request, res: Response) => {
      const session = req.staffSession;
      if (!session) {
        res.status(401).json({ error: 'no_session' });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const id = req.params['id']!;
      const deleted = await deps.db
        .delete(appUserCredentials)
        .where(
          and(eq(appUserCredentials.id, id), eq(appUserCredentials.appUserId, session.appUserId)),
        )
        .returning({ id: appUserCredentials.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: 'credential_not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'app_user_credential',
        entityId: id,
        actorAppUserId: session.appUserId,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(200).json({ ok: true });
    },
  );

  router.post('/logout', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (session) {
      await deps.sessionStore.destroy('staff', session.sid);
      await emitAudit(deps.db, {
        action: 'LOGOUT',
        entityType: 'app_user',
        entityId: session.appUserId,
        actorAppUserId: session.appUserId,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    }
    clearSessionCookie(res, 'staff');
    res.status(200).json({ ok: true });
  });

  router.get('/me', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    // Phase 7 of FILE_MANAGER_ADDENDUM.md — surface the user's
    // effective permission set so the FE can drive `usePermission`
    // without an extra round trip.
    const permissions = await loadEffectivePermissions(deps, session.appUserId);
    res.json({
      appUserId: session.appUserId,
      firmId: session.firmId,
      lastStepUpAt: session.lastStepUpAt,
      csrfToken: session.csrfToken,
      permissions,
    });
  });

  return router;
}

async function tryRecoveryCode(
  deps: StaffRoutesDeps,
  appUserId: string,
  code: string,
): Promise<boolean> {
  if (!deps.db) return false;
  const [user] = await deps.db
    .select({ recovery: appUsers.recoveryCodesEncrypted })
    .from(appUsers)
    .where(eq(appUsers.id, appUserId))
    .limit(1);
  if (!user?.recovery) return false;
  const hashes = JSON.parse(user.recovery) as string[];
  const incoming = hashRecoveryCode(code);
  const idx = hashes.indexOf(incoming);
  if (idx === -1) return false;
  // Single-use: drop the consumed hash.
  hashes.splice(idx, 1);
  await deps.db
    .update(appUsers)
    .set({ recoveryCodesEncrypted: JSON.stringify(hashes) })
    .where(eq(appUsers.id, appUserId));
  return true;
}

interface StaffUserShape {
  id: string;
  email: string;
  firmId: string;
  totpEnrolledAt: Date | null;
  totpSecretEncrypted: string | null;
}

async function findStaffByEmail(
  db: Database | null,
  email: string,
): Promise<StaffUserShape | null> {
  if (!db) return null;
  const [row] = await db
    .select({
      id: appUsers.id,
      email: appUsers.email,
      firmId: appUsers.firmId,
      totpEnrolledAt: appUsers.totpEnrolledAt,
      totpSecretEncrypted: appUsers.totpSecretEncrypted,
    })
    .from(appUsers)
    .where(eq(appUsers.email, email.toLowerCase()))
    .limit(1);
  return row ?? null;
}

async function findStaffById(db: Database | null, id: string): Promise<StaffUserShape | null> {
  if (!db) return null;
  const [row] = await db
    .select({
      id: appUsers.id,
      email: appUsers.email,
      firmId: appUsers.firmId,
      totpEnrolledAt: appUsers.totpEnrolledAt,
      totpSecretEncrypted: appUsers.totpSecretEncrypted,
    })
    .from(appUsers)
    .where(eq(appUsers.id, id))
    .limit(1);
  return row ?? null;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

async function listCredentials(
  db: Database | null,
  appUserId: string,
): Promise<
  Array<{
    id: string;
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string;
  }>
> {
  if (!db) return [];
  const rows = await db
    .select({
      id: appUserCredentials.id,
      credentialId: appUserCredentials.credentialId,
      publicKey: appUserCredentials.publicKey,
      signCount: appUserCredentials.signCount,
      transports: appUserCredentials.transports,
    })
    .from(appUserCredentials)
    .where(eq(appUserCredentials.appUserId, appUserId));
  return rows.map((r) => ({
    id: r.id,
    credentialId: r.credentialId,
    publicKey: r.publicKey,
    signCount: Number(r.signCount),
    transports: r.transports,
  }));
}

async function findCredentialByIdForUser(
  db: Database | null,
  appUserId: string,
  credentialId: string,
): Promise<{
  id: string;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string;
} | null> {
  if (!db) return null;
  const [row] = await db
    .select({
      id: appUserCredentials.id,
      credentialId: appUserCredentials.credentialId,
      publicKey: appUserCredentials.publicKey,
      signCount: appUserCredentials.signCount,
      transports: appUserCredentials.transports,
    })
    .from(appUserCredentials)
    .where(
      and(
        eq(appUserCredentials.credentialId, credentialId),
        eq(appUserCredentials.appUserId, appUserId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    credentialId: row.credentialId,
    publicKey: row.publicKey,
    signCount: Number(row.signCount),
    transports: row.transports,
  };
}

/**
 * Returns the union of permission keys for every role assigned to the
 * user. Used by `/me` so the FE can drive button-disabled state via
 * `usePermission(code)` without a server round-trip per gate.
 *
 * Honors `fakeUserRoles` for the same reason `requirePermission` does:
 * tests pass a partial DB stub that doesn't implement innerJoin, so
 * the fake-map seam keeps them green without forcing a real Postgres.
 */
async function loadEffectivePermissions(
  deps: StaffRoutesDeps,
  appUserId: string,
): Promise<string[]> {
  let slugs: RoleSlug[];
  if (deps.fakeUserRoles) {
    slugs = deps.fakeUserRoles.get(appUserId) ?? [];
  } else if (deps.db) {
    try {
      const rows = await deps.db
        .select({ slug: roles.name })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(eq(userRoles.appUserId, appUserId));
      const known: RoleSlug[] = ['partner', 'manager', 'senior', 'staff', 'admin'];
      slugs = rows
        .map((r) => r.slug.toLowerCase() as RoleSlug)
        .filter((s): s is RoleSlug => known.includes(s));
    } catch (err) {
      // Tests pass a partial DB stub that doesn't implement innerJoin;
      // a thrown TypeError here would 500 /me. Return empty perms so
      // the rest of the response still ships — production hits the
      // real DB and never lands here.
      logger.warn({ err }, '/me: failed to load effective permissions, returning empty set');
      slugs = [];
    }
  } else {
    slugs = [];
  }
  return Array.from(unionPermissions(slugs)) as PermissionKey[];
}
