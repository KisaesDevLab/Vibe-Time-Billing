// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client portal authentication routes.
// - Email path → magic link signed with PORTAL_JWT_SECRET (distinct from staff)
// - Phone path → SMS OTP (6 digits, 5-minute TTL)
// - Active-client switcher uses the session's `active_client_id`.

import express, { type Request, type Response, type Router } from 'express';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';

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
import { clientPortalAccess, portalIdentity, portalInvitation } from '@vibe/db/schema';

import { loadConfig } from '../config';
import { logger } from '../logger';
import { firmScope, renderTemplate } from '../notifications/templating';
import { ImpersonationTokenError, verifyImpersonationToken } from '../tax-returns/impersonation';
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
  /**
   * TR-5 / view-as-client — the secret used to sign + verify staff
   * impersonation JWTs (a key derived from STAFF_JWT_SECRET). When unset
   * the /impersonate-exchange endpoint returns 503 so the appliance can
   * still serve the portal in environments that haven't wired this up.
   */
  staffSecret?: string | null;
}

// Q6 — phone re-verification on every new device. We fingerprint by
// IP + user-agent (best-effort) and keep a per-identity set of known
// devices in Redis. A magic-link sign-in from an unrecognized device is
// challenged with an SMS OTP before a session is issued (only when the
// identity has a verified phone to challenge against).
const DEVICE_TTL_SECONDS = 180 * 24 * 3600;

function deviceFingerprint(req: Request): string {
  const ip = clientIp(req) ?? '';
  const ua = req.header('user-agent') ?? '';
  return createHash('sha256').update(`${ip}\n${ua}`).digest('hex').slice(0, 32);
}

async function isKnownDevice(redis: Redis, identityId: string, fp: string): Promise<boolean> {
  try {
    return (await redis.sismember(`portal:devices:${identityId}`, fp)) === 1;
  } catch {
    // Fail open on Redis trouble — don't lock users out of the portal.
    return true;
  }
}

async function rememberDevice(redis: Redis, identityId: string, fp: string): Promise<void> {
  try {
    const key = `portal:devices:${identityId}`;
    await redis.sadd(key, fp);
    await redis.expire(key, DEVICE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err }, 'portal device remember failed');
  }
}

const LoginSchema = z.object({ contact: z.string().min(3).max(254) });
const VerifyDeviceSchema = z.object({
  challengeToken: z.string().min(1).max(128),
  code: z.string().regex(/^\d{6}$/),
});
const VerifyMagicSchema = z.object({ token: z.string().min(1) });
const VerifyOtpSchema = z.object({
  phone: z.string().min(5),
  code: z.string().regex(/^\d{6}$/),
  // P4.3 — H.5 — TCPA SMS opt-in capture. When the portal client
  // sends back the consent text + version they displayed alongside
  // the code-entry form, we persist it as the audit trail. Optional
  // so legacy clients without the new screen still verify, but the
  // FE always sends these on first-time verification flows.
  smsConsentText: z.string().max(2000).optional(),
  smsConsentVersion: z.string().max(40).optional(),
});
const SwitchClientSchema = z.object({ clientId: z.string().uuid() });
const ImpersonateExchangeSchema = z.object({ token: z.string().min(20).max(4096) });
const AcceptInvitationSchema = z.object({ token: z.string().min(8).max(200) });

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
      res.status(200).json({ ...GENERIC_RESPONSE, access: false });
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
        res.status(200).json({ ...GENERIC_RESPONSE, access: false });
        return;
      }
      const id = await findIdentityByEmail(deps.db, email);
      const access = id ? await hasActiveAccess(deps.db, id.id) : false;
      if (id && access) {
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
        const rendered = await renderTemplate({
          db: deps.db,
          firmId: id.firmId,
          kind: 'magic_link',
          channel: 'EMAIL',
          fallback: { subject: 'Your sign-in link', body: link },
          context: { firm: await firmScope(deps.db, id.firmId), auth: { magic_url: link } },
        });
        await deps
          .sendEmail({
            to: email,
            subject: rendered.subject ?? 'Your sign-in link',
            body: rendered.body,
          })
          .catch((err: unknown) => logger.error({ err }, 'portal magic-link delivery'));
      }
      res.status(200).json({ ...GENERIC_RESPONSE, access });
      return;
    }

    if (kind === 'phone') {
      const phone = normalizePhone(parsed.data.contact);
      if (!phone) {
        res.status(200).json({ ...GENERIC_RESPONSE, access: false });
        return;
      }
      const cl = await checkAndIncrement(deps.redis, {
        key: `rl:portal:login:contact:${phone}`,
        windowSeconds: 15 * 60,
        max: 5,
      });
      if (!cl.allowed) {
        res.status(200).json({ ...GENERIC_RESPONSE, access: false });
        return;
      }
      const id = await findIdentityByPhone(deps.db, phone);
      const access = id ? await hasActiveAccess(deps.db, id.id) : false;
      if (id && access) {
        const code = generateSmsOtp();
        await deps.redis.set(
          `portal:otp:${phone}`,
          JSON.stringify({ hash: hashSmsOtp(code), identityId: id.id, attempts: 0 }),
          'EX',
          cfg.SMS_OTP_TTL_MINUTES * 60,
        );
        const rendered = await renderTemplate({
          db: deps.db,
          firmId: id.firmId,
          kind: 'sms_otp',
          channel: 'SMS',
          fallback: { body: `Your Vibe sign-in code: ${code}` },
          context: { firm: await firmScope(deps.db, id.firmId), auth: { code } },
        });
        await deps
          .sendSms({ to: phone, body: rendered.body })
          .catch((err: unknown) => logger.error({ err }, 'portal sms delivery'));
      }
      res.status(200).json({ ...GENERIC_RESPONSE, access });
      return;
    }

    // Unknown kind — route to request access.
    res.status(200).json({ ...GENERIC_RESPONSE, access: false });
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

    // Q6 — new-device check. Email possession is proven by the link; if the
    // device is unrecognized and the identity has a verified phone, step up
    // with an SMS OTP before issuing the session.
    const fp = deviceFingerprint(req);
    const known = await isKnownDevice(deps.redis, payload.sub, fp);
    if (!known && deps.db) {
      const [idn] = await deps.db
        .select({
          phone: portalIdentity.primaryPhone,
          phoneVerifiedAt: portalIdentity.primaryPhoneVerifiedAt,
        })
        .from(portalIdentity)
        .where(eq(portalIdentity.id, payload.sub))
        .limit(1);
      if (idn?.phone && idn.phoneVerifiedAt) {
        const cfg2 = loadConfig();
        const code = generateSmsOtp();
        const challengeToken = randomNonce();
        await deps.redis.set(
          `portal:devotp:${challengeToken}`,
          JSON.stringify({
            hash: hashSmsOtp(code),
            identityId: payload.sub,
            firmId: payload.fid,
            attempts: 0,
          }),
          'EX',
          cfg2.SMS_OTP_TTL_MINUTES * 60,
        );
        const rendered = await renderTemplate({
          db: deps.db,
          firmId: payload.fid,
          kind: 'sms_otp',
          channel: 'SMS',
          fallback: { body: `Your Vibe device-verification code: ${code}` },
          context: { firm: await firmScope(deps.db, payload.fid), auth: { code } },
        });
        await deps
          .sendSms({ to: idn.phone, body: rendered.body })
          .catch((err: unknown) => logger.error({ err }, 'portal device otp delivery'));
        res.status(200).json({
          deviceChallenge: true,
          challengeToken,
          phoneHint: idn.phone.slice(-4),
        });
        return;
      }
      // No verified phone to challenge — record the device and continue.
    }
    await rememberDevice(deps.redis, payload.sub, fp);
    await issueSession(deps, res, req, payload.sub, payload.fid);
  });

  // Q6 — complete a new-device challenge: verify the SMS code tied to the
  // challenge token, record the device, and issue the session.
  router.post('/verify-device-otp', async (req: Request, res: Response) => {
    const parsed = VerifyDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const key = `portal:devotp:${parsed.data.challengeToken}`;
    const raw = await deps.redis.get(key);
    if (!raw) {
      res.status(401).json({ error: 'no_pending_challenge' });
      return;
    }
    const state = JSON.parse(raw) as {
      hash: string;
      identityId: string;
      firmId: string;
      attempts: number;
    };
    state.attempts += 1;
    if (state.attempts > 5) {
      await deps.redis.del(key);
      res.status(429).json({ error: 'too_many_attempts' });
      return;
    }
    if (hashSmsOtp(parsed.data.code) !== state.hash) {
      await deps.redis.set(key, JSON.stringify(state), 'KEEPTTL');
      res.status(401).json({ error: 'invalid_code' });
      return;
    }
    await deps.redis.del(key);
    await rememberDevice(deps.redis, state.identityId, deviceFingerprint(req));
    await issueSession(deps, res, req, state.identityId, state.firmId);
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
    // If the caller sent TCPA consent text + version (FE shows it on
    // the first verification screen), stamp consent at the same time —
    // SMS senders must check sms_consent_at IS NOT NULL before
    // delivering to this identity.
    if (deps.db) {
      const update: Record<string, unknown> = { primaryPhoneVerifiedAt: new Date() };
      if (parsed.data.smsConsentText && parsed.data.smsConsentVersion) {
        update['smsConsentText'] = parsed.data.smsConsentText;
        update['smsConsentVersion'] = parsed.data.smsConsentVersion;
        update['smsConsentAt'] = new Date();
        update['smsConsentIp'] = clientIp(req);
      }
      await deps.db
        .update(portalIdentity)
        .set(update)
        .where(eq(portalIdentity.id, state.identityId));
    }
    const identity = await findIdentityById(deps.db, state.identityId);
    if (!identity) {
      res.status(401).json({ error: 'unknown_identity' });
      return;
    }
    // SMS possession on this device — trust it for future magic-link logins.
    await rememberDevice(deps.redis, identity.id, deviceFingerprint(req));
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
      isImpersonation: s.isImpersonation ?? false,
      impersonatedByEmail: s.impersonatedByEmail ?? null,
    });
  });

  // TR-5 — staff "view as client" exchange. Trades a short-lived
  // impersonation JWT (minted by POST /api/staff/clients/:id/impersonate)
  // for a real __vibe_portal_session cookie scoped to the access row.
  // The session is read-only (portal-middleware blocks non-GET) and
  // soft-expires 60 min after createdAt regardless of cookie TTL.
  router.post('/impersonate-exchange', async (req: Request, res: Response) => {
    if (!deps.staffSecret) {
      res.status(503).json({ error: 'impersonation_not_configured' });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = ImpersonateExchangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    let claims;
    try {
      claims = await verifyImpersonationToken(deps.staffSecret, parsed.data.token);
    } catch (err) {
      const code = err instanceof ImpersonationTokenError ? err.code : 'invalid';
      res.status(401).json({ error: 'invalid_token', code });
      return;
    }

    // Resolve the access row → portal_identity_id and confirm the
    // (access, client) pair the staff caller authorized in the token
    // still exists + is active.
    const [access] = await deps.db
      .select({
        id: clientPortalAccess.id,
        portalIdentityId: clientPortalAccess.portalIdentityId,
        clientId: clientPortalAccess.clientId,
        status: clientPortalAccess.status,
      })
      .from(clientPortalAccess)
      .where(eq(clientPortalAccess.id, claims.accessId))
      .limit(1);
    if (!access || access.clientId !== claims.clientId) {
      res.status(404).json({ error: 'access_not_found' });
      return;
    }
    if (access.status !== 'ACTIVE') {
      res.status(403).json({ error: 'access_inactive' });
      return;
    }

    const identity = await findIdentityById(deps.db, access.portalIdentityId);
    if (!identity) {
      res.status(404).json({ error: 'identity_not_found' });
      return;
    }

    await issueSession(deps, res, req, identity.id, identity.firmId, {
      impersonation: {
        staffUserId: claims.staffUserId,
        staffEmail: claims.staffEmail,
        overrideActiveClientId: claims.clientId,
      },
    });
  });

  // Portal invitation acceptance — recipient of a portal_invitation
  // email/SMS lands at portal.firm.com/auth/accept?token=<raw> which
  // POSTs the raw token here. We:
  //   1. SHA-256 the token + look up the invitation row
  //   2. Validate it's ACTIVE + not expired
  //   3. Find-or-create a portal_identity at the same firm matching
  //      the invited email/phone (so existing identities get a new
  //      access row attached without proliferating duplicates)
  //   4. Create / reactivate the client_portal_access row (status=ACTIVE)
  //   5. Mark the invitation USED + stamp portalIdentityId
  //   6. Issue a portal session cookie so the invitee lands on the
  //      portal home directly — they don't have to do a second
  //      magic-link round-trip just to start their first session
  router.post('/accept-invitation', async (req: Request, res: Response) => {
    const parsed = AcceptInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }

    const tokenHash = createHash('sha256').update(parsed.data.token).digest('hex');
    const [inv] = await deps.db
      .select()
      .from(portalInvitation)
      .where(eq(portalInvitation.tokenHash, tokenHash))
      .limit(1);
    if (!inv) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    if (inv.status !== 'ACTIVE') {
      res.status(410).json({ error: 'invitation_already_used', status: inv.status });
      return;
    }
    if (inv.expiresAt.getTime() < Date.now()) {
      await deps.db
        .update(portalInvitation)
        .set({ status: 'EXPIRED' })
        .where(eq(portalInvitation.id, inv.id))
        .catch(() => undefined);
      res.status(410).json({ error: 'invitation_expired' });
      return;
    }

    // Step 1 — find-or-create the portal_identity. Prefer matching on
    // whichever contact was used to deliver the invitation; fall back
    // to the other if it's also populated.
    let identityId: string | null = null;
    if (inv.invitedEmail) {
      const [byEmail] = await deps.db
        .select({ id: portalIdentity.id })
        .from(portalIdentity)
        .where(
          and(
            eq(portalIdentity.firmId, inv.firmId),
            eq(portalIdentity.primaryEmail, inv.invitedEmail),
          ),
        )
        .limit(1);
      if (byEmail) identityId = byEmail.id;
    }
    if (!identityId && inv.invitedPhone) {
      const [byPhone] = await deps.db
        .select({ id: portalIdentity.id })
        .from(portalIdentity)
        .where(
          and(
            eq(portalIdentity.firmId, inv.firmId),
            eq(portalIdentity.primaryPhone, inv.invitedPhone),
          ),
        )
        .limit(1);
      if (byPhone) identityId = byPhone.id;
    }
    if (!identityId) {
      const now = new Date();
      const [created] = await deps.db
        .insert(portalIdentity)
        .values({
          firmId: inv.firmId,
          fullName: inv.proposedFullName,
          primaryEmail: inv.invitedEmail,
          primaryEmailVerifiedAt: inv.deliveryChannel === 'EMAIL' && inv.invitedEmail ? now : null,
          primaryPhone: inv.invitedPhone,
          primaryPhoneVerifiedAt: inv.deliveryChannel === 'SMS' && inv.invitedPhone ? now : null,
          preferredMethod: inv.deliveryChannel === 'SMS' ? 'SMS' : 'EMAIL',
          status: 'ACTIVE',
        })
        .returning({ id: portalIdentity.id });
      identityId = created!.id;
    }

    // Step 2 — find-or-create the client_portal_access row for this
    // (identity, client) pair. INVITED → ACTIVE flip if a placeholder
    // already exists; otherwise insert fresh.
    const now = new Date();
    const [existingAccess] = await deps.db
      .select({ id: clientPortalAccess.id, status: clientPortalAccess.status })
      .from(clientPortalAccess)
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, identityId),
          eq(clientPortalAccess.clientId, inv.clientId),
        ),
      )
      .limit(1);
    if (existingAccess) {
      await deps.db
        .update(clientPortalAccess)
        .set({
          status: 'ACTIVE',
          role: inv.proposedRole,
          acceptedAt: now,
          revokedAt: null,
          revokedBy: null,
        })
        .where(eq(clientPortalAccess.id, existingAccess.id));
    } else {
      await deps.db.insert(clientPortalAccess).values({
        portalIdentityId: identityId,
        clientId: inv.clientId,
        role: inv.proposedRole,
        status: 'ACTIVE',
        invitedBy: inv.invitedBy,
        invitedAt: inv.invitedAt,
        acceptedAt: now,
      });
    }

    // Step 3 — mark the invitation USED so the magic link can't be
    // replayed and the staff UI's "Pending invitations" list updates.
    await deps.db
      .update(portalInvitation)
      .set({
        status: 'USED',
        portalIdentityId: identityId,
        usedAt: now,
      })
      .where(eq(portalInvitation.id, inv.id));

    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'client_portal_access',
      entityId: identityId,
      actorPortalIdentityId: identityId,
      activeClientId: inv.clientId,
      after: { acceptedFromInvitationId: inv.id, clientId: inv.clientId },
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    // Step 4 — issue a portal session so the invitee lands on the
    // portal home directly with the right active client.
    await issueSession(deps, res, req, identityId, inv.firmId);
  });

  return router;
}

interface IssueSessionOptions {
  /**
   * TR-5 — when set, the session is flagged as staff impersonation:
   * (1) the portal /me response surfaces a banner, (2) the middleware
   * rejects non-GET requests, (3) the session soft-expires 60 min after
   * createdAt regardless of the cookie TTL. The portal_identity_id and
   * activeClientId still belong to the impersonated client; the staff
   * actor is recorded for audit + UI only.
   */
  impersonation?: {
    staffUserId: string;
    staffEmail: string;
    /** Pin the active client to the access row the token authorized. */
    overrideActiveClientId: string;
  };
}

async function issueSession(
  deps: PortalRoutesDeps,
  res: Response,
  req: Request,
  identityId: string,
  firmId: string,
  options: IssueSessionOptions = {},
): Promise<void> {
  // Default active client = first active access; require at least one.
  let activeClientId: string | null = options.impersonation?.overrideActiveClientId ?? null;
  if (!activeClientId && deps.db) {
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
    ...(options.impersonation
      ? {
          isImpersonation: true,
          impersonatedByStaffUserId: options.impersonation.staffUserId,
          impersonatedByEmail: options.impersonation.staffEmail,
        }
      : {}),
  };
  await deps.sessionStore.put(session);
  writeSessionCookie(res, 'portal', session.sid);

  if (options.impersonation) {
    // Audit attribution belongs to the staff actor; the impersonated
    // identity rides along in the after payload so the row is still
    // searchable by client + identity for reviews.
    await emitAudit(deps.db, {
      action: 'IMPERSONATE',
      entityType: 'portal_identity',
      entityId: identityId,
      actorAppUserId: options.impersonation.staffUserId,
      activeClientId,
      after: { portalIdentityId: identityId, staffEmail: options.impersonation.staffEmail },
      ip: session.ip,
      userAgent: session.userAgent,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
  } else {
    await emitAudit(deps.db, {
      action: 'LOGIN',
      entityType: 'portal_identity',
      entityId: identityId,
      actorPortalIdentityId: identityId,
      activeClientId,
      ip: session.ip,
      userAgent: session.userAgent,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
  }

  res.json({
    ok: true,
    csrfToken: session.csrfToken,
    activeClientId,
    ...(options.impersonation ? { isImpersonation: true as const } : {}),
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

// Does this identity have at least one ACTIVE client access? Drives the
// sign-in screen's auto-route: with access we send a link/code, without it
// we send the visitor to Request access. (Relaxes QUESTIONS #29 by design —
// the firm opted for usability over account-enumeration opacity here.)
async function hasActiveAccess(db: Database | null, identityId: string): Promise<boolean> {
  if (!db) return false;
  const [row] = await db
    .select({ id: clientPortalAccess.id })
    .from(clientPortalAccess)
    .where(
      and(
        eq(clientPortalAccess.portalIdentityId, identityId),
        eq(clientPortalAccess.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  return Boolean(row);
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
