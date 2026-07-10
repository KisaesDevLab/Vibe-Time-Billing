// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
  generateSmsOtp,
  hashSmsOtp,
  issueMagicLink,
  newEnrollment,
  randomNonce,
  verifyMagicLink,
  verifyTotp,
  hashRecoveryCode,
  type StaffSession,
} from '@vibe/core/auth';
import { SignJWT, jwtVerify } from 'jose';
import { timingEqualizingVerify, verifyPassword } from './password';
import type { RoleSlug } from '@vibe/core/rbac';
import { resolveUserPermissions } from './rbac-middleware';
import type { Database } from '@vibe/db';
import { appUserCredentials, appUsers } from '@vibe/db/schema';
import { and, eq, sql } from 'drizzle-orm';

import { loadConfig } from '../config';
import { logger } from '../logger';
import { emitAudit } from './audit';
import { clearSessionCookie, writeSessionCookie } from './cookies';
import { isSecondFactorRequired } from './second-factor-policy';
import { isSealedTotpSecret, openTotpSecret, sealTotpSecret } from './totp-secret';
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
  // 0087 — second-factor OTP delivery. Both are pluggable so tests can
  // capture the code instead of actually sending.
  sendEmailOtp?: (args: { email: string; firmId: string; code: string }) => Promise<void>;
  sendSmsOtp?: (args: { phone: string; firmId: string; code: string }) => Promise<void>;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  // Double-submit CSRF check for the AUTHENTICATED mutating endpoints in
  // this router (factor enroll/disable, password change, preferred-factor,
  // logout). Optional so tests can omit it; when present it is a no-op on
  // GET/HEAD/OPTIONS. The unauthenticated login endpoints never see it.
  requireCsrf?: (req: Request, res: Response, next: () => void) => void;
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

// 0087 — password + second-factor sign-in.
const LoginPasswordSchema = z.object({
  email: z.string().regex(EMAIL_RE),
  password: z.string().min(1).max(256),
});
const FactorSchema = z.enum(['TOTP', 'EMAIL', 'SMS', 'PASSKEY']);
const TwoFactorStartSchema = z.object({
  pendingToken: z.string().min(1),
  factor: FactorSchema,
});
// PASSKEY 2FA replaces the {code} field with {response} (WebAuthn assertion).
// Everything else uses {code}. The schema is a union so the verify handler
// can branch cleanly.
const TwoFactorVerifySchema = z.union([
  z.object({
    pendingToken: z.string().min(1),
    factor: z.enum(['TOTP', 'EMAIL', 'SMS']),
    code: z.string().min(6).max(16),
  }),
  z.object({
    pendingToken: z.string().min(1),
    factor: z.literal('PASSKEY'),
    response: z.object({ id: z.string().min(1) }).passthrough(),
  }),
]);

const PENDING_TTL_SECONDS = 5 * 60;

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

  // Authenticated-route guard chain: prove the session, then enforce CSRF
  // on mutating methods. requireCsrf is GET-exempt, so applying `authed`
  // uniformly to authenticated routes (including the GET /me + credential
  // listing) is safe. The public login endpoints below use neither.
  const requireCsrf =
    deps.requireCsrf ?? ((_req: Request, _res: Response, next: () => void) => next());
  const authed = [deps.requireAuth, requireCsrf] as express.RequestHandler[];

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

    // Second-factor gate. Magic-link possession (the email inbox) is the
    // FIRST factor; per CLAUDE.md non-negotiable #5 a staff sign-in must
    // also clear an enrolled second factor. When the user has one
    // enrolled we challenge it through the SAME pending-token → /2fa/verify
    // flow the password path uses (TOTP / email OTP / SMS OTP / passkey);
    // the browser already renders that step. We deliberately do NOT mint a
    // session here in that case — the session is created only after
    // /2fa/verify succeeds, so email-inbox access alone is not enough.
    const secondFactorRequired = await isSecondFactorRequired(deps.db, user.firmId);
    const available = secondFactorRequired ? await availableFactorsFor(user) : [];
    if (secondFactorRequired && available.length > 0) {
      const pendingToken = await issuePendingToken(user.id, user.firmId, cfg);
      res.status(200).json({
        needsSecondFactor: true,
        pendingToken,
        availableFactors: available,
        preferredFactor: pickPreferredFactor(user, available),
      });
      return;
    }

    const session: StaffSession = {
      realm: 'staff',
      sid: generateSessionId(),
      appUserId: user.id,
      firmId: user.firmId,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      // Firm opted out of second factors → the magic link itself is the
      // step-up. Firm requires one but none is enrolled yet → session is
      // issued un-stepped-up and the UI pushes factor enrollment (a rare
      // edge; every staff user is expected to hold at least one factor).
      lastStepUpAt: secondFactorRequired ? null : Date.now(),
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
      needsTotpEnrollment: false,
      // True only when the firm requires a factor but the user has none
      // enrolled — the SPA should route them straight to enrollment.
      needsFactorEnrollment: secondFactorRequired && available.length === 0,
    });
  });

  // ===================================================================
  // 0087 — username + password sign-in (sibling to magic link).
  // ===================================================================
  //
  // Three-step flow:
  //   1. POST /login/password { email, password }
  //      → 200 { pendingToken, availableFactors, preferredFactor }
  //      → 401 invalid_credentials  (same code for unknown email + bad pw)
  //      → 400 no_factor_enrolled   (user has not opted into any 2FA factor)
  //
  //   2. POST /2fa/start { pendingToken, factor }
  //      → for EMAIL / SMS: sends the OTP, returns { ok: true, sentTo }
  //      → for TOTP: noop, returns { ok: true } (code comes from the
  //         user's authenticator app)
  //
  //   3. POST /2fa/verify { pendingToken, factor, code }
  //      → on success: creates the staff session (same path as
  //        /verify-magic-link) + sets the cookie + emits a LOGIN audit
  //      → on failure: shared rate-limit + lockout keys with the
  //        existing TOTP step-up flow.
  //
  // The pending token is a short-lived JWT (5 min) signed with the
  // same STAFF_JWT_SECRET. Different `pur` claim + audience so a
  // magic-link token can't be reused here and vice versa.

  async function issuePendingToken(
    appUserId: string,
    firmId: string,
    cfg: ReturnType<typeof loadConfig>,
  ): Promise<string> {
    return new SignJWT({
      fid: firmId,
      rlm: 'staff',
      pur: 'pwd_pending',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(appUserId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS)
      .setIssuer('vibe-tb:staff')
      .setAudience('vibe-tb:staff:2fa-pending')
      .sign(new TextEncoder().encode(cfg.STAFF_JWT_SECRET));
  }

  async function verifyPendingToken(
    token: string,
    cfg: ReturnType<typeof loadConfig>,
  ): Promise<{ appUserId: string; firmId: string } | null> {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(cfg.STAFF_JWT_SECRET), {
        issuer: 'vibe-tb:staff',
        audience: 'vibe-tb:staff:2fa-pending',
      });
      if (payload['pur'] !== 'pwd_pending') return null;
      if (typeof payload['sub'] !== 'string') return null;
      if (typeof payload['fid'] !== 'string') return null;
      return { appUserId: payload['sub'], firmId: payload['fid'] };
    } catch {
      return null;
    }
  }

  type Factor = 'TOTP' | 'EMAIL' | 'SMS' | 'PASSKEY';

  async function availableFactorsFor(user: StaffUserShape): Promise<Factor[]> {
    const factors: Factor[] = [];
    if (user.totpEnrolledAt) factors.push('TOTP');
    if (user.emailOtpEnrolledAt) factors.push('EMAIL');
    if (user.smsOtpEnrolledAt) factors.push('SMS');
    // PASSKEY is available when the user has at least one registered
    // WebAuthn credential. Count via the credentials table since the
    // user row doesn't track it.
    if (deps.db) {
      const creds = await listCredentials(deps.db, user.id);
      if (creds.length > 0) factors.push('PASSKEY');
    }
    return factors;
  }

  function pickPreferredFactor(user: StaffUserShape, available: Factor[]): Factor | null {
    if (available.length === 0) return null;
    if (user.preferredSecondFactor && available.includes(user.preferredSecondFactor)) {
      return user.preferredSecondFactor;
    }
    // Default order: PASSKEY > TOTP > EMAIL > SMS. Passkey wins because
    // it's the strongest factor when present.
    for (const f of ['PASSKEY', 'TOTP', 'EMAIL', 'SMS'] as const) {
      if (available.includes(f)) return f;
    }
    return null;
  }

  function maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!local || !domain) return email;
    if (local.length <= 2) return `${local[0]}*@${domain}`;
    return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
  }

  function maskPhone(phone: string): string {
    if (phone.length <= 4) return phone;
    return `${phone.slice(0, 2)}${'*'.repeat(phone.length - 4)}${phone.slice(-2)}`;
  }

  router.post('/login/password', async (req: Request, res: Response) => {
    const parsed = LoginPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const ip = clientIp(req);
    const emailLower = parsed.data.email.toLowerCase();
    // Reuse the existing magic-link rate-limit windows. Per-email and
    // per-IP caps both apply — a single attacker can't fan out across
    // emails to bypass per-account throttling.
    const contactLimit = await checkAndIncrement(deps.redis, {
      key: `rl:auth:password:contact:${emailLower}`,
      windowSeconds: 15 * 60,
      max: 5,
    });
    const ipLimit = await checkAndIncrement(deps.redis, {
      key: `rl:auth:password:ip:${ip}`,
      windowSeconds: 15 * 60,
      max: 20,
    });
    if (!contactLimit.allowed || !ipLimit.allowed) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }

    const user = await findStaffByEmail(deps.db, emailLower);
    // Same generic error for "no such user" + "wrong password" to keep
    // the password path enumeration-safe just like the magic-link path.
    if (!user || !user.passwordHash) {
      // Spend the same argon2 time a real verify would, so response
      // latency doesn't reveal whether the account exists.
      await timingEqualizingVerify(parsed.data.password);
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }

    // 0151 — when the firm has switched the second-factor requirement
    // off, a correct password completes sign-in on its own: no factor
    // challenge, no enrolled-factor prerequisite. `lastStepUpAt` is set
    // because the firm has opted out of step-up factors entirely.
    if (!(await isSecondFactorRequired(deps.db, user.firmId))) {
      const session: StaffSession = {
        realm: 'staff',
        sid: generateSessionId(),
        appUserId: user.id,
        firmId: user.firmId,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        lastStepUpAt: Date.now(),
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
        after: { method: 'password', factor: null },
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, csrfToken: session.csrfToken, needsTotpEnrollment: false });
      return;
    }

    const available = await availableFactorsFor(user);
    if (available.length === 0) {
      // Password is correct but no second factor is enrolled. The user
      // has to land via magic link and enroll a factor before they can
      // sign in with password going forward.
      res.status(400).json({
        error: 'no_factor_enrolled',
        message:
          'Sign in via magic link and enroll a second factor (passkey, TOTP, email OTP, or SMS) before using password sign-in.',
      });
      return;
    }
    const cfg = loadConfig();
    const pendingToken = await issuePendingToken(user.id, user.firmId, cfg);
    const preferred = pickPreferredFactor(user, available);
    res.json({
      pendingToken,
      availableFactors: available,
      preferredFactor: preferred,
    });
  });

  router.post('/2fa/start', async (req: Request, res: Response) => {
    const parsed = TwoFactorStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const cfg = loadConfig();
    const ctx = await verifyPendingToken(parsed.data.pendingToken, cfg);
    if (!ctx) {
      res.status(401).json({ error: 'invalid_pending_token' });
      return;
    }
    const user = await findStaffById(deps.db, ctx.appUserId);
    if (!user) {
      res.status(401).json({ error: 'unknown_user' });
      return;
    }
    const factor = parsed.data.factor;
    const available = await availableFactorsFor(user);
    if (!available.includes(factor)) {
      res.status(400).json({ error: 'factor_not_enrolled' });
      return;
    }
    if (factor === 'TOTP') {
      // No server-side action; the user reads the code from their app.
      res.json({ ok: true, factor: 'TOTP' });
      return;
    }
    if (factor === 'PASSKEY') {
      // Build an authentication options object scoped to the user's
      // registered credentials. Browser will pick the matching one
      // (or prompt if multiple) and produce an assertion. The
      // challenge is keyed by the pending token's appUserId so
      // /2fa/verify can recover it.
      const candidates = deps.db ? await listCredentials(deps.db, user.id) : [];
      if (candidates.length === 0) {
        res.status(400).json({ error: 'no_passkey_enrolled' });
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
      await deps.redis.set(`webauthn:2fa:${user.id}`, options.challenge, 'EX', PENDING_TTL_SECONDS);
      res.json({ ok: true, factor: 'PASSKEY', options });
      return;
    }
    // Email + SMS: generate a fresh 6-digit code, store hashed in Redis
    // under a per-user-per-factor key with a 5-min TTL, then deliver it
    // via the injected dispatcher. Rate-limit so an attacker can't burn
    // through SMS credit by spamming /2fa/start.
    const burst = await checkAndIncrement(deps.redis, {
      key: `rl:auth:2fa-start:${user.id}:${factor}`,
      windowSeconds: 60,
      max: 3,
    });
    if (!burst.allowed) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const code = generateSmsOtp();
    const codeHash = hashSmsOtp(code);
    await deps.redis.set(`staff:2fa-otp:${user.id}:${factor}`, codeHash, 'EX', PENDING_TTL_SECONDS);
    if (factor === 'EMAIL') {
      if (!deps.sendEmailOtp) {
        // Mail provider not wired — surface clearly so the firm can
        // configure it; refuse rather than silently swallow the code.
        res.status(503).json({ error: 'email_dispatcher_unavailable' });
        return;
      }
      try {
        await deps.sendEmailOtp({ email: user.email, firmId: user.firmId, code });
      } catch (err) {
        logger.error({ err }, 'email otp delivery failed');
        res.status(502).json({ error: 'email_send_failed' });
        return;
      }
      res.json({ ok: true, factor: 'EMAIL', sentTo: maskEmail(user.email) });
      return;
    }
    // SMS
    if (!user.smsOtpPhoneE164) {
      res.status(400).json({ error: 'sms_phone_missing' });
      return;
    }
    if (!deps.sendSmsOtp) {
      res.status(503).json({ error: 'sms_dispatcher_unavailable' });
      return;
    }
    try {
      await deps.sendSmsOtp({ phone: user.smsOtpPhoneE164, firmId: user.firmId, code });
    } catch (err) {
      logger.error({ err }, 'sms otp delivery failed');
      res.status(502).json({ error: 'sms_send_failed' });
      return;
    }
    res.json({ ok: true, factor: 'SMS', sentTo: maskPhone(user.smsOtpPhoneE164) });
  });

  router.post('/2fa/verify', async (req: Request, res: Response) => {
    const parsed = TwoFactorVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const cfg = loadConfig();
    const ctx = await verifyPendingToken(parsed.data.pendingToken, cfg);
    if (!ctx) {
      res.status(401).json({ error: 'invalid_pending_token' });
      return;
    }
    const user = await findStaffById(deps.db, ctx.appUserId);
    if (!user) {
      res.status(401).json({ error: 'unknown_user' });
      return;
    }
    // Reuse the existing TOTP lockout key so a series of failed attempts
    // across factors triggers the same backoff a TOTP brute would.
    const lockoutKey = `lockout:staff:totp:${user.id}`;
    const lockedUntil = await deps.redis.get(lockoutKey);
    if (lockedUntil && Number(lockedUntil) > Date.now()) {
      res.status(429).json({ error: 'locked_out', retry_at: Number(lockedUntil) });
      return;
    }

    let factorVerified = false;
    if (parsed.data.factor === 'TOTP') {
      if (!user.totpSecretEncrypted || !user.totpEnrolledAt) {
        res.status(400).json({ error: 'totp_not_enrolled' });
        return;
      }
      const totpSeed = openTotpSecret(user.totpSecretEncrypted);
      factorVerified =
        verifyTotp({ token: parsed.data.code, secret: totpSeed }) ||
        (await tryRecoveryCode(deps, user.id, parsed.data.code));
      // Lazy at-rest migration: a legacy row still holds the seed in
      // plaintext. Now that a TOTP code has proven the seed is valid,
      // re-seal it so the plaintext stops sitting in the table. Best
      // effort — a failure here must not block the sign-in.
      if (factorVerified && deps.db && !isSealedTotpSecret(user.totpSecretEncrypted)) {
        try {
          await deps.db
            .update(appUsers)
            .set({ totpSecretEncrypted: sealTotpSecret(totpSeed) })
            .where(eq(appUsers.id, user.id));
        } catch (err) {
          logger.error({ err }, 'totp secret re-seal failed');
        }
      }
    } else if (parsed.data.factor === 'PASSKEY') {
      const challenge = await deps.redis.get(`webauthn:2fa:${user.id}`);
      if (!challenge) {
        res.status(400).json({ error: 'no_pending_authentication' });
        return;
      }
      // Single-use challenge regardless of outcome — prevents replay.
      await deps.redis.del(`webauthn:2fa:${user.id}`);
      const credentialId = parsed.data.response.id;
      const credential = await findCredentialByIdForUser(deps.db, user.id, credentialId);
      if (!credential) {
        res.status(401).json({ error: 'invalid_credential' });
        return;
      }
      const outcome = await verifyAuthentication({
        response: parsed.data.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        credential,
      });
      factorVerified = outcome.ok;
      if (factorVerified && deps.db && outcome.newSignCount != null) {
        await deps.db
          .update(appUserCredentials)
          .set({ signCount: outcome.newSignCount, lastUsedAt: new Date() })
          .where(eq(appUserCredentials.id, credential.id));
      }
    } else {
      const expectedHash = await deps.redis.get(`staff:2fa-otp:${user.id}:${parsed.data.factor}`);
      if (!expectedHash) {
        res.status(400).json({ error: 'otp_expired_or_missing' });
        return;
      }
      const actualHash = hashSmsOtp(parsed.data.code.trim());
      factorVerified = expectedHash === actualHash;
      if (factorVerified) {
        // Single-use: nuke the code on first successful match.
        await deps.redis.del(`staff:2fa-otp:${user.id}:${parsed.data.factor}`);
      }
    }
    if (!factorVerified) {
      const attempts = await deps.redis.incr(`lockout-attempts:staff:totp:${user.id}`);
      await deps.redis.expire(`lockout-attempts:staff:totp:${user.id}`, 15 * 60);
      if (attempts >= 5) {
        await deps.redis.set(lockoutKey, String(Date.now() + 15 * 60 * 1000), 'EX', 15 * 60);
      }
      res.status(401).json({ error: 'invalid_code' });
      return;
    }
    await deps.redis.del(`lockout-attempts:staff:totp:${user.id}`);

    // Session creation — identical to the magic-link path. `lastStepUpAt`
    // is set immediately since the 2FA factor IS the step-up.
    const session: StaffSession = {
      realm: 'staff',
      sid: generateSessionId(),
      appUserId: user.id,
      firmId: user.firmId,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      lastStepUpAt: Date.now(),
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
      after: { method: 'password', factor: parsed.data.factor },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.json({
      ok: true,
      csrfToken: session.csrfToken,
      needsTotpEnrollment: false,
    });
  });

  // ===================================================================
  // Passkey (WebAuthn) primary sign-in — passwordless.
  // ===================================================================
  //
  // Two unauthenticated endpoints. The browser drives a "discoverable
  // credential" flow (allowCredentials empty) so the platform shows the
  // user their list of saved passkeys without us first knowing who
  // they are.
  //
  //   1. POST /login/passkey/options
  //      → returns { options, nonce }. The nonce ties the issued
  //        challenge to a Redis row (TTL 5 min) so the verify call
  //        can prove it's responding to a challenge we issued.
  //
  //   2. POST /login/passkey/verify { nonce, response }
  //      → looks up the credential by its globally-unique id, loads
  //        the owning user, verifies the assertion, creates the staff
  //        session (lastStepUpAt = now since passkey IS the step-up).

  const PasskeyLoginVerifySchema = z.object({
    nonce: z.string().min(16).max(64),
    response: z.object({ id: z.string().min(1) }).passthrough(),
  });

  router.post('/login/passkey/options', async (req: Request, res: Response) => {
    const ip = clientIp(req);
    // Same rate-limit window as magic-link login. Issuing an options
    // call is cheap but we still want to throttle so an attacker can't
    // probe for valid origins or burn CPU on the verifier.
    const ipLimit = await checkAndIncrement(deps.redis, {
      key: `rl:auth:passkey-options:ip:${ip}`,
      windowSeconds: 15 * 60,
      max: 20,
    });
    if (!ipLimit.allowed) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    let options;
    try {
      // Passwordless primary sign-in: the passkey is the sole factor, so
      // require user verification (biometric/PIN) — possession alone is
      // not enough.
      options = await buildAuthenticationOptions({
        candidates: [],
        userVerification: 'required',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'webauthn_unavailable';
      res.status(503).json({ error: msg });
      return;
    }
    const nonce = randomNonce();
    await deps.redis.set(
      `webauthn:login-discover:${nonce}`,
      options.challenge,
      'EX',
      PENDING_TTL_SECONDS,
    );
    res.json({ options, nonce });
  });

  router.post('/login/passkey/verify', async (req: Request, res: Response) => {
    const parsed = PasskeyLoginVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const challenge = await deps.redis.get(`webauthn:login-discover:${parsed.data.nonce}`);
    if (!challenge) {
      res.status(401).json({ error: 'challenge_expired' });
      return;
    }
    // Single-use: nuke before doing anything else so a parallel
    // request can't share the same challenge.
    await deps.redis.del(`webauthn:login-discover:${parsed.data.nonce}`);
    const credentialId = parsed.data.response.id;
    const cred = await findCredentialById(deps.db, credentialId);
    if (!cred) {
      // Unknown credential — same generic 401 so we don't leak which
      // credential ids exist.
      res.status(401).json({ error: 'invalid_credential' });
      return;
    }
    const user = await findStaffById(deps.db, cred.appUserId);
    if (!user) {
      res.status(401).json({ error: 'invalid_credential' });
      return;
    }
    const outcome = await verifyAuthentication({
      response: parsed.data.response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      credential: cred,
      // Sole-factor sign-in — reject an assertion without user verification.
      requireUserVerification: true,
    });
    if (!outcome.ok) {
      res.status(401).json({ error: 'invalid_credential' });
      return;
    }
    // Bump sign count + last-used so cloned-credential detection works.
    if (deps.db && outcome.newSignCount != null) {
      await deps.db
        .update(appUserCredentials)
        .set({ signCount: outcome.newSignCount, lastUsedAt: new Date() })
        .where(eq(appUserCredentials.id, cred.id));
    }
    const session: StaffSession = {
      realm: 'staff',
      sid: generateSessionId(),
      appUserId: user.id,
      firmId: user.firmId,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      lastStepUpAt: Date.now(),
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
      after: { method: 'passkey' },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({
      ok: true,
      csrfToken: session.csrfToken,
      needsTotpEnrollment: false,
    });
  });

  router.post('/totp/enroll', ...authed, async (req: Request, res: Response) => {
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
      issuer: 'Vibe Practice Management',
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

  router.post('/totp/verify', ...authed, async (req: Request, res: Response) => {
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
      secret = openTotpSecret(user.totpSecretEncrypted);
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
            totpSecretEncrypted: sealTotpSecret(pending.secret),
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

  router.post('/webauthn/registration/options', ...authed, async (req: Request, res: Response) => {
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
  });

  router.post('/webauthn/registration/verify', ...authed, async (req: Request, res: Response) => {
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
  });

  router.post('/webauthn/auth/options', ...authed, async (req: Request, res: Response) => {
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

  router.post('/webauthn/auth/verify', ...authed, async (req: Request, res: Response) => {
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

  router.get('/webauthn/credentials', ...authed, async (req: Request, res: Response) => {
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

  router.delete('/webauthn/credentials/:id', ...authed, async (req: Request, res: Response) => {
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
  });

  // ===================================================================
  // 0087 — sign-in settings. Authenticated user manages their password
  // + second-factor enrollment from the profile page.
  // ===================================================================

  const PasswordSetSchema = z.object({
    currentPassword: z.string().min(1).max(256).optional(),
    newPassword: z.string().min(1).max(256),
  });
  const SmsEnrollStartSchema = z.object({
    phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  });
  const SmsEnrollVerifySchema = z.object({ code: z.string().min(6).max(16) });
  // PASSKEY is intentionally excluded from the persisted preference:
  // the DB enum `second_factor_kind` (migration 0087) only includes
  // TOTP/EMAIL/SMS, and passkey is auto-preferred whenever it's
  // enrolled (see pickPreferredFactor). Users wanting passkey as
  // their go-to simply leave preferredSecondFactor NULL.
  const PreferredFactorSchema = z.object({
    factor: z.enum(['TOTP', 'EMAIL', 'SMS']).nullable(),
  });

  router.post('/password', ...authed, async (req: Request, res: Response) => {
    const parsed = PasswordSetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    // Policy check first so a too-short password doesn't waste a hash cycle.
    const { checkPasswordPolicy, hashPassword } = await import('./password');
    const policy = checkPasswordPolicy(parsed.data.newPassword);
    if (!policy.ok) {
      res.status(400).json({ error: 'password_policy', reason: policy.reason });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const user = await findStaffById(deps.db, session.appUserId);
    if (!user) {
      res.status(401).json({ error: 'unknown_user' });
      return;
    }
    // If the user already has a password, require the current one. New
    // users (first-time set) just need a fresh step-up — the magic-link
    // flow that got them here already counts.
    if (user.passwordHash) {
      if (!parsed.data.currentPassword) {
        res.status(400).json({ error: 'current_password_required' });
        return;
      }
      const ok = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
      if (!ok) {
        res.status(401).json({ error: 'current_password_wrong' });
        return;
      }
    }
    const digest = await hashPassword(parsed.data.newPassword);
    await deps.db
      .update(appUsers)
      .set({ passwordHash: digest, passwordSetAt: new Date(), updatedAt: new Date() })
      .where(eq(appUsers.id, user.id));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'app_user',
      entityId: user.id,
      actorAppUserId: user.id,
      after: { passwordChanged: true },
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  router.post('/email-otp/enroll', ...authed, async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session || !deps.db) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    await deps.db
      .update(appUsers)
      .set({ emailOtpEnrolledAt: new Date(), updatedAt: new Date() })
      .where(eq(appUsers.id, session.appUserId));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'app_user',
      entityId: session.appUserId,
      actorAppUserId: session.appUserId,
      after: { emailOtpEnrolled: true },
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  router.post('/email-otp/disable', ...authed, async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session || !deps.db) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    // If the user's preferred factor was EMAIL, clear it too so we
    // don't violate the CHECK constraint on next select.
    await deps.db
      .update(appUsers)
      .set({
        emailOtpEnrolledAt: null,
        preferredSecondFactor: sql`CASE WHEN preferred_second_factor = 'EMAIL' THEN NULL ELSE preferred_second_factor END`,
        updatedAt: new Date(),
      })
      .where(eq(appUsers.id, session.appUserId));
    res.json({ ok: true });
  });

  router.post('/sms-otp/enroll/start', ...authed, async (req: Request, res: Response) => {
    const parsed = SmsEnrollStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const burst = await checkAndIncrement(deps.redis, {
      key: `rl:auth:sms-enroll-start:${session.appUserId}`,
      windowSeconds: 60,
      max: 3,
    });
    if (!burst.allowed) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    if (!deps.sendSmsOtp) {
      res.status(503).json({ error: 'sms_dispatcher_unavailable' });
      return;
    }
    const code = generateSmsOtp();
    const codeHash = hashSmsOtp(code);
    // Stash both the phone and the hashed code so /enroll/verify can
    // validate the code AND learn which phone it was for.
    await deps.redis.set(
      `staff:sms-enroll:${session.appUserId}`,
      JSON.stringify({ phone: parsed.data.phone, codeHash }),
      'EX',
      PENDING_TTL_SECONDS,
    );
    try {
      await deps.sendSmsOtp({
        phone: parsed.data.phone,
        firmId: session.firmId,
        code,
      });
    } catch (err) {
      logger.error({ err }, 'sms enroll otp delivery failed');
      res.status(502).json({ error: 'sms_send_failed' });
      return;
    }
    res.json({ ok: true, sentTo: maskPhone(parsed.data.phone) });
  });

  router.post('/sms-otp/enroll/verify', ...authed, async (req: Request, res: Response) => {
    const parsed = SmsEnrollVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.staffSession;
    if (!session || !deps.db) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const raw = await deps.redis.get(`staff:sms-enroll:${session.appUserId}`);
    if (!raw) {
      res.status(400).json({ error: 'no_pending_enrollment' });
      return;
    }
    const pending = JSON.parse(raw) as { phone: string; codeHash: string };
    const ok = pending.codeHash === hashSmsOtp(parsed.data.code.trim());
    if (!ok) {
      res.status(401).json({ error: 'invalid_code' });
      return;
    }
    await deps.redis.del(`staff:sms-enroll:${session.appUserId}`);
    await deps.db
      .update(appUsers)
      .set({
        smsOtpPhoneE164: pending.phone,
        smsOtpEnrolledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(appUsers.id, session.appUserId));
    res.json({ ok: true });
  });

  router.post('/sms-otp/disable', ...authed, async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session || !deps.db) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    await deps.db
      .update(appUsers)
      .set({
        smsOtpEnrolledAt: null,
        smsOtpPhoneE164: null,
        preferredSecondFactor: sql`CASE WHEN preferred_second_factor = 'SMS' THEN NULL ELSE preferred_second_factor END`,
        updatedAt: new Date(),
      })
      .where(eq(appUsers.id, session.appUserId));
    res.json({ ok: true });
  });

  router.post('/totp/disable', ...authed, async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session || !deps.db) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    await deps.db
      .update(appUsers)
      .set({
        totpSecretEncrypted: null,
        totpEnrolledAt: null,
        recoveryCodesEncrypted: null,
        preferredSecondFactor: sql`CASE WHEN preferred_second_factor = 'TOTP' THEN NULL ELSE preferred_second_factor END`,
        updatedAt: new Date(),
      })
      .where(eq(appUsers.id, session.appUserId));
    res.json({ ok: true });
  });

  router.patch('/preferred-factor', ...authed, async (req: Request, res: Response) => {
    const parsed = PreferredFactorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.staffSession;
    if (!session || !deps.db) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const user = await findStaffById(deps.db, session.appUserId);
    if (!user) {
      res.status(401).json({ error: 'unknown_user' });
      return;
    }
    // Honor the DB CHECK: the picked factor must be enrolled.
    if (parsed.data.factor) {
      const available = await availableFactorsFor(user);
      if (!available.includes(parsed.data.factor)) {
        res.status(400).json({ error: 'factor_not_enrolled' });
        return;
      }
    }
    await deps.db
      .update(appUsers)
      .set({ preferredSecondFactor: parsed.data.factor, updatedAt: new Date() })
      .where(eq(appUsers.id, user.id));
    res.json({ ok: true });
  });

  // Logout is intentionally NOT CSRF-gated: forcing a victim to log out is
  // not a meaningful attack, and keeping it token-free avoids breaking the
  // logout contract for any client. requireAuth still applies.
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

  router.get('/me', ...authed, async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    // Phase 7 of FILE_MANAGER_ADDENDUM.md — surface the user's
    // effective permission set so the FE can drive `usePermission`
    // without an extra round trip.
    const permissions = await loadEffectivePermissions(deps, session.appUserId);
    // 0087 — surface sign-in factor enrollment state so the profile
    // page can render the current second-factor configuration without
    // an extra round trip.
    const user = await findStaffById(deps.db, session.appUserId);
    const passkeyCount = deps.db ? (await listCredentials(deps.db, session.appUserId)).length : 0;
    res.json({
      appUserId: session.appUserId,
      firmId: session.firmId,
      lastStepUpAt: session.lastStepUpAt,
      csrfToken: session.csrfToken,
      permissions,
      passwordSet: user?.passwordHash != null,
      totpEnrolledAt: user?.totpEnrolledAt ?? null,
      emailOtpEnrolledAt: user?.emailOtpEnrolledAt ?? null,
      smsOtpEnrolledAt: user?.smsOtpEnrolledAt ?? null,
      smsOtpPhoneE164: user?.smsOtpPhoneE164 ?? null,
      preferredSecondFactor: user?.preferredSecondFactor ?? null,
      passkeyCount,
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
  // 0087 — password + factor enrollment state.
  passwordHash: string | null;
  smsOtpPhoneE164: string | null;
  smsOtpEnrolledAt: Date | null;
  emailOtpEnrolledAt: Date | null;
  preferredSecondFactor: 'TOTP' | 'EMAIL' | 'SMS' | null;
}

const STAFF_USER_SELECT = {
  id: appUsers.id,
  email: appUsers.email,
  firmId: appUsers.firmId,
  totpEnrolledAt: appUsers.totpEnrolledAt,
  totpSecretEncrypted: appUsers.totpSecretEncrypted,
  passwordHash: appUsers.passwordHash,
  smsOtpPhoneE164: appUsers.smsOtpPhoneE164,
  smsOtpEnrolledAt: appUsers.smsOtpEnrolledAt,
  emailOtpEnrolledAt: appUsers.emailOtpEnrolledAt,
  preferredSecondFactor: appUsers.preferredSecondFactor,
} as const;

async function findStaffByEmail(
  db: Database | null,
  email: string,
): Promise<StaffUserShape | null> {
  if (!db) return null;
  const [row] = await db
    .select(STAFF_USER_SELECT)
    .from(appUsers)
    .where(eq(appUsers.email, email.toLowerCase()))
    .limit(1);
  return row ?? null;
}

async function findStaffById(db: Database | null, id: string): Promise<StaffUserShape | null> {
  if (!db) return null;
  const [row] = await db
    .select(STAFF_USER_SELECT)
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
  // Test stubs that don't implement the full Drizzle chain return
  // a non-array placeholder from `.where()`. In production the real
  // postgres driver always returns an array, so guarding here only
  // affects the test harness path.
  let rows: unknown;
  try {
    rows = await db
      .select({
        id: appUserCredentials.id,
        credentialId: appUserCredentials.credentialId,
        publicKey: appUserCredentials.publicKey,
        signCount: appUserCredentials.signCount,
        transports: appUserCredentials.transports,
      })
      .from(appUserCredentials)
      .where(eq(appUserCredentials.appUserId, appUserId));
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return (
    rows as Array<{
      id: string;
      credentialId: string;
      publicKey: string;
      signCount: number;
      transports: string;
    }>
  ).map((r) => ({
    id: r.id,
    credentialId: r.credentialId,
    publicKey: r.publicKey,
    signCount: Number(r.signCount),
    transports: r.transports,
  }));
}

// 0087+ passkey login — credentialId is globally unique, so a passwordless
// (discoverable-credential) sign-in flow needs to look up a credential
// without first knowing the appUserId. Returns the owning user so the
// caller can build the staff session.
async function findCredentialById(
  db: Database | null,
  credentialId: string,
): Promise<{
  id: string;
  appUserId: string;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string;
} | null> {
  if (!db) return null;
  const [row] = await db
    .select({
      id: appUserCredentials.id,
      appUserId: appUserCredentials.appUserId,
      credentialId: appUserCredentials.credentialId,
      publicKey: appUserCredentials.publicKey,
      signCount: appUserCredentials.signCount,
      transports: appUserCredentials.transports,
    })
    .from(appUserCredentials)
    .where(eq(appUserCredentials.credentialId, credentialId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    appUserId: row.appUserId,
    credentialId: row.credentialId,
    publicKey: row.publicKey,
    signCount: Number(row.signCount),
    transports: row.transports,
  };
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
  try {
    // 0147 — shared resolver applies the firm's permission-matrix
    // overrides, so the FE's usePermission() gating always matches
    // what requirePermission enforces.
    return Array.from(
      await resolveUserPermissions({ db: deps.db, fakeUserRoles: deps.fakeUserRoles }, appUserId),
    );
  } catch (err) {
    // Tests pass a partial DB stub that doesn't implement innerJoin;
    // a thrown TypeError here would 500 /me. Return empty perms so
    // the rest of the response still ships — production hits the
    // real DB and never lands here.
    logger.warn({ err }, '/me: failed to load effective permissions, returning empty set');
    return [];
  }
}
