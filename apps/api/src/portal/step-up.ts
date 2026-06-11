// SPDX-License-Identifier: Elastic-2.0
//
// Portal step-up verification (Connect addendum I.3 + I.4).
//
// Distinct from the staff step-up flow:
// - Staff use TOTP. Portal users use one of: ssn-last-4 / ein /
//   email-otp / sms-otp. Firm config picks which is active; v1 ships
//   email-otp + sms-otp end-to-end. ssn-last-4 and ein are stubbed
//   pending clients.tax_id_hash storage.
// - Staff freshness lives on the session row (last_step_up_at). Portal
//   freshness lives in Redis: `portal:step-up:{identityId}:{clientId}`
//   with TTL = STEP_UP_TIMEOUT_MINUTES * 60.
// - Lockout: same 5-failures / 15-min / 30-min ban shape as staff,
//   keyed on portal_identity_id.
//
// Endpoints (mounted under /api/portal/step-up):
//   POST /issue    — body: { type, reason }
//                    → 202 { challengeId, channel, sentTo?, expiresAt }
//   POST /verify   — body: { challengeId, value }
//                    → 200 { ok: true, freshUntil }
//                    → 401 { error: 'invalid_value', attempts }
//                    → 429 { error: 'step_up_locked_out', retryAfter }

import { createHash, randomInt } from 'node:crypto';

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, isNull, sql as drz } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import { clients, portalIdentity, portalStepUpChallenge } from '@vibe/db/schema';

import { loadConfig } from '../config';
import { logger } from '../logger';
import { emitAudit } from '../auth/audit';

const CHALLENGE_TTL_SEC = 5 * 60;
const LOCKOUT_WINDOW_SEC = 15 * 60;
const LOCKOUT_MAX_FAILURES = 5;
const LOCKOUT_DURATION_SEC = 30 * 60;

// All four challenge types are valid at the API boundary now that
// client.tax_id_hash is wired. Knowledge-factor variants (ssn-last-4
// / ein) require the firm to have set TAX_ID_HASH_PEPPER + enrolled
// the client; otherwise issue returns 400 challenge_type_not_available.
const IssueSchema = z.object({
  type: z.enum(['email-otp', 'sms-otp', 'ssn-last-4', 'ein']),
  reason: z.string().max(200).optional(),
});

const VerifySchema = z.object({
  challengeId: z.string().uuid(),
  value: z.string().min(1).max(40),
});

export interface PortalStepUpDeps {
  db: Database | null;
  redis: Redis;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
  /**
   * Optional hook to surface lockouts to firm admins (I.6). The caller
   * passes the firmId + identity. Defaults to a no-op.
   */
  onLockout?: (args: {
    firmId: string;
    portalIdentityId: string;
    expiresAt: Date;
  }) => Promise<void>;
}

function lockoutKey(identityId: string): string {
  return `portal-step-up:lockout:${identityId}`;
}
function failuresKey(identityId: string): string {
  return `portal-step-up:failures:${identityId}`;
}
function freshnessKey(identityId: string, clientId: string): string {
  return `portal:step-up:${identityId}:${clientId}`;
}

async function getLockoutTtl(redis: Redis, identityId: string): Promise<number | null> {
  const ttl = await redis.ttl(lockoutKey(identityId));
  return ttl > 0 ? ttl : null;
}

async function recordFailure(
  redis: Redis,
  identityId: string,
): Promise<{ lockedOut: boolean; attempts: number }> {
  const k = failuresKey(identityId);
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, LOCKOUT_WINDOW_SEC);
  if (count >= LOCKOUT_MAX_FAILURES) {
    await redis.set(lockoutKey(identityId), '1', 'EX', LOCKOUT_DURATION_SEC);
    await redis.del(k);
    return { lockedOut: true, attempts: count };
  }
  return { lockedOut: false, attempts: count };
}

async function clearFailures(redis: Redis, identityId: string): Promise<void> {
  await redis.del(failuresKey(identityId));
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function createPortalStepUpRouter(deps: PortalStepUpDeps): Router {
  const router = express.Router();

  router.post('/issue', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const parsed = IssueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const lockTtl = await getLockoutTtl(deps.redis, session.portalIdentityId);
    if (lockTtl != null) {
      res.status(429).json({ error: 'step_up_locked_out', retryAfter: lockTtl });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }

    // Cancel any pending open challenges for this identity — only one
    // is valid at a time. Defense against an attacker piling up issued
    // challenges to brute-force in parallel.
    await deps.db
      .update(portalStepUpChallenge)
      .set({
        completedAt: new Date(),
        reason: drz`COALESCE(${portalStepUpChallenge.reason}, '') || ' [superseded]'`,
      })
      .where(
        and(
          eq(portalStepUpChallenge.portalIdentityId, session.portalIdentityId),
          isNull(portalStepUpChallenge.completedAt),
        ),
      );

    const challengeType = parsed.data.type;
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SEC * 1000);
    let otpHash: string | null = null;
    let sentTo: string | null = null;
    let channel: 'EMAIL' | 'SMS' | null = null;

    // Knowledge-factor branches gate on (a) the pepper being
    // configured and (b) the client having an enrolled tax_id_hash of
    // the matching kind. Otherwise 400 so the UI can fall back to
    // email-otp.
    if (challengeType === 'ssn-last-4' || challengeType === 'ein') {
      const { isFeatureEnabled } = await import('./tax-id');
      if (!isFeatureEnabled()) {
        res.status(400).json({ error: 'challenge_type_not_available' });
        return;
      }
      const expectedKind = challengeType === 'ssn-last-4' ? 'ssn_last4' : 'ein';
      const activeClientId = session.activeClientId;
      if (!activeClientId) {
        res.status(400).json({ error: 'no_active_client' });
        return;
      }
      const [client] = await deps.db
        .select({ taxIdKind: clients.taxIdKind, taxIdHash: clients.taxIdHash })
        .from(clients)
        .where(eq(clients.id, activeClientId))
        .limit(1);
      if (!client || client.taxIdKind !== expectedKind || !client.taxIdHash) {
        res.status(400).json({ error: 'challenge_type_not_available' });
        return;
      }
      // No OTP code for knowledge factors — the value IS the secret.
      // otpHash stays null; verify branches on challengeType.
    } else if (challengeType === 'email-otp' || challengeType === 'sms-otp') {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      otpHash = sha256Hex(code);
      const [identity] = await deps.db
        .select({
          email: portalIdentity.primaryEmail,
          phone: portalIdentity.primaryPhone,
          smsConsentAt: portalIdentity.smsConsentAt,
        })
        .from(portalIdentity)
        .where(eq(portalIdentity.id, session.portalIdentityId))
        .limit(1);
      if (!identity) {
        res.status(404).json({ error: 'identity_not_found' });
        return;
      }
      if (challengeType === 'email-otp') {
        if (!identity.email || !deps.sendEmail) {
          res.status(400).json({ error: 'email_unavailable' });
          return;
        }
        await deps.sendEmail({
          to: identity.email,
          subject: 'Verification code',
          body: `Your verification code is ${code}. Expires in 5 minutes.`,
        });
        sentTo = identity.email;
        channel = 'EMAIL';
      } else {
        // sms-otp
        if (!identity.phone || !deps.sendSms) {
          res.status(400).json({ error: 'sms_unavailable' });
          return;
        }
        if (!identity.smsConsentAt) {
          // P4.3 invariant: no SMS without explicit TCPA consent.
          res.status(409).json({ error: 'sms_consent_required' });
          return;
        }
        await deps.sendSms({
          to: identity.phone,
          body: `Verification code: ${code} (expires 5 min)`,
        });
        sentTo = identity.phone;
        channel = 'SMS';
      }
    }
    // No fallthrough — the two if-blocks above are exhaustive over
    // IssueSchema's union.

    const [row] = await deps.db
      .insert(portalStepUpChallenge)
      .values({
        firmId: session.firmId,
        portalIdentityId: session.portalIdentityId,
        activeClientId: session.activeClientId ?? null,
        challengeType,
        otpHash,
        reason: parsed.data.reason ?? null,
        expiresAt,
      })
      .returning({ id: portalStepUpChallenge.id });
    if (!row) {
      res.status(500).json({ error: 'challenge_insert_failed' });
      return;
    }
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'portal_step_up_challenge',
      entityId: row.id,
      actorPortalIdentityId: session.portalIdentityId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      after: { type: challengeType, channel, reason: parsed.data.reason ?? null },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed (step-up issue)'));
    res.status(202).json({
      challengeId: row.id,
      channel,
      sentTo: sentTo ? maskContact(sentTo) : null,
      expiresAt: expiresAt.toISOString(),
    });
  });

  router.post('/verify', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const lockTtl = await getLockoutTtl(deps.redis, session.portalIdentityId);
    if (lockTtl != null) {
      res.status(429).json({ error: 'step_up_locked_out', retryAfter: lockTtl });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [row] = await deps.db
      .select()
      .from(portalStepUpChallenge)
      .where(
        and(
          eq(portalStepUpChallenge.id, parsed.data.challengeId),
          eq(portalStepUpChallenge.portalIdentityId, session.portalIdentityId),
        ),
      )
      .limit(1);
    if (!row || row.completedAt || row.expiresAt < new Date()) {
      const fail = await recordFailure(deps.redis, session.portalIdentityId);
      if (fail.lockedOut && deps.onLockout) {
        await deps
          .onLockout({
            firmId: session.firmId,
            portalIdentityId: session.portalIdentityId,
            expiresAt: new Date(Date.now() + LOCKOUT_DURATION_SEC * 1000),
          })
          .catch((err) => logger.error({ err }, 'onLockout hook failed'));
      }
      res.status(401).json({ error: 'invalid_or_expired_challenge', lockedOut: fail.lockedOut });
      return;
    }

    let ok = false;
    if (row.challengeType === 'email-otp' || row.challengeType === 'sms-otp') {
      ok = row.otpHash !== null && row.otpHash === sha256Hex(parsed.data.value);
    } else if (row.challengeType === 'ssn-last-4' || row.challengeType === 'ein') {
      // Look up the active client's stored hash + constant-time
      // compare. The session's activeClientId is the scope guard —
      // verifying against another client's hash is impossible.
      const expectedKind = row.challengeType === 'ssn-last-4' ? 'ssn_last4' : 'ein';
      const activeClientId = session.activeClientId;
      if (activeClientId) {
        const [client] = await deps.db
          .select({ taxIdKind: clients.taxIdKind, taxIdHash: clients.taxIdHash })
          .from(clients)
          .where(eq(clients.id, activeClientId))
          .limit(1);
        if (client && client.taxIdKind === expectedKind && client.taxIdHash) {
          const { verifyTaxId } = await import('./tax-id');
          ok = verifyTaxId(expectedKind, parsed.data.value, client.taxIdHash);
        }
      }
    }

    // Always bump attempts so brute-force is bounded.
    await deps.db
      .update(portalStepUpChallenge)
      .set({ attempts: row.attempts + 1, completedAt: ok ? new Date() : null })
      .where(eq(portalStepUpChallenge.id, row.id));

    if (!ok) {
      const fail = await recordFailure(deps.redis, session.portalIdentityId);
      if (fail.lockedOut && deps.onLockout) {
        await deps
          .onLockout({
            firmId: session.firmId,
            portalIdentityId: session.portalIdentityId,
            expiresAt: new Date(Date.now() + LOCKOUT_DURATION_SEC * 1000),
          })
          .catch((err) => logger.error({ err }, 'onLockout hook failed'));
      }
      res.status(401).json({
        error: 'invalid_value',
        attempts: row.attempts + 1,
        lockedOut: fail.lockedOut,
      });
      return;
    }

    await clearFailures(deps.redis, session.portalIdentityId);

    // Stamp freshness in Redis with the same TTL the staff side uses.
    const cfg = loadConfig();
    const ttl = Math.max(60, cfg.STEP_UP_TIMEOUT_MINUTES * 60);
    const clientId = session.activeClientId ?? 'global';
    await deps.redis.set(
      freshnessKey(session.portalIdentityId, clientId),
      Date.now().toString(),
      'EX',
      ttl,
    );

    await emitAudit(deps.db, {
      action: 'LOGIN',
      entityType: 'portal_step_up_challenge',
      entityId: row.id,
      actorPortalIdentityId: session.portalIdentityId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      after: { type: row.challengeType, completed: true },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed (step-up verify)'));

    res.json({
      ok: true,
      freshUntil: new Date(Date.now() + ttl * 1000).toISOString(),
    });
  });

  return router;
}

/**
 * Portal step-up middleware. Use to gate routes where the user must
 * have completed a step-up challenge within the configured TTL.
 *
 * On failure: writes the 403 response with `{ error: 'step_up_required' }`
 * and returns. The frontend api-client intercepts this and opens the
 * step-up modal.
 */
export function requirePortalStepUp(redis: Redis) {
  return async (req: Request, res: Response, next: () => void): Promise<void> => {
    const session = req.portalSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const lockTtl = await getLockoutTtl(redis, session.portalIdentityId);
    if (lockTtl != null) {
      res.status(429).json({ error: 'step_up_locked_out', retryAfter: lockTtl });
      return;
    }
    const clientId = session.activeClientId ?? 'global';
    const fresh = await redis.get(freshnessKey(session.portalIdentityId, clientId));
    if (!fresh) {
      res.status(403).json({ error: 'step_up_required' });
      return;
    }
    next();
  };
}

function maskContact(value: string): string {
  if (value.includes('@')) {
    const [local, domain] = value.split('@', 2);
    if (!local || !domain) return value;
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
  }
  // E.164-ish phone — keep country code + last 2.
  if (value.length <= 4) return value;
  return `${value.slice(0, 3)}${'*'.repeat(value.length - 5)}${value.slice(-2)}`;
}
