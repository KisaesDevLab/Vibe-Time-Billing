// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0218 — public ACH micro-deposit verification (open internet surface).
// Lets a client confirm the micro-deposit amounts for a pending manual
// ACH bank WITHOUT a portal session: the link token is the credential.
// The action can only make the client's OWN bank chargeable by the firm
// that already holds a signed authorization — no money moves here.
//
// Routes (all unauthenticated):
//   GET  /api/ach-verify/:token         — safe summary for the landing page
//   POST /api/ach-verify/:token/verify  — submit amounts or descriptor code
//
// Enumeration posture (CLAUDE.md #29): an unknown/malformed token gets the
// same 404 {error:'not_found'} as a missing one. Verify attempts are
// rate-limited hard per IP — Stripe also fails the SetupIntent after a few
// wrong guesses, at which point the method must be re-entered by staff.
// Per-IP rate limits fail OPEN on Redis errors — an infra hiccup must not
// take the public surface down.

import express, { type Request, type Response, type Router, type NextFunction } from 'express';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clients, firms, firmSettings, paymentMethod } from '@vibe/db/schema';
import { checkAndIncrement } from '@vibe/core/auth';

import { logger } from '../logger';
import { emitAudit } from '../auth/audit';
import { verifyMicrodeposits } from '../payments/manual-ach';
import {
  achVerifyLinkUsable,
  closeAchVerifyLinks,
  markAchVerifyLinkAccessed,
  resolveAchVerifyLink,
  type AchVerifyLinkRow,
} from '../payments/ach-verify-link';

export interface AchVerifyPublicDeps {
  db: Database | null;
  redis?: Redis;
  /** Test seam — forwarded to the Stripe verify call. */
  fetchImpl?: typeof fetch;
}

const TOKEN_RE = /^[A-Za-z0-9._-]{16,400}$/;

const IP_WINDOW_SECONDS = 60;
const IP_MAX_PER_WINDOW = 30;
// Verify attempts: Stripe kills the SetupIntent after ~3 wrong guesses, so a
// tight window costs a legitimate client nothing while stopping scripts.
const VERIFY_WINDOW_SECONDS = 900;
const VERIFY_MAX_PER_WINDOW = 10;

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.ip ?? '0.0.0.0').trim();
}

async function withinIpLimit(
  redis: Redis | undefined,
  req: Request,
  res: Response,
  scope: string,
  windowSeconds: number,
  max: number,
): Promise<boolean> {
  if (!redis) return true;
  try {
    const limit = await checkAndIncrement(redis, {
      key: `rl:ach-verify:${scope}:${clientIp(req)}`,
      windowSeconds,
      max,
    });
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      res.status(429).json({ error: 'rate_limited' });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, 'ach-verify rate limiter error; allowing request');
    return true;
  }
}

/** Resolve + validate the :token param; 404 uniformly on any miss. */
async function loadLink(
  db: Database,
  req: Request,
  res: Response,
): Promise<AchVerifyLinkRow | null> {
  const token = req.params['token'] ?? '';
  if (!TOKEN_RE.test(token)) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const link = await resolveAchVerifyLink(db, token);
  if (!link) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return link;
}

export function createAchVerifyPublicRouter(deps: AchVerifyPublicDeps): Router {
  const router = express.Router();

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!(await withinIpLimit(deps.redis, req, res, 'base', IP_WINDOW_SECONDS, IP_MAX_PER_WINDOW)))
      return;
    next();
  });

  // GET /:token — safe summary for the landing page.
  router.get('/:token', async (req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const link = await loadLink(deps.db, req, res);
    if (!link) return;

    const [pm] = await deps.db
      .select({
        displayLabel: paymentMethod.displayLabel,
        lastFour: paymentMethod.lastFour,
        verificationStatus: paymentMethod.verificationStatus,
        status: paymentMethod.status,
        clientId: paymentMethod.clientId,
      })
      .from(paymentMethod)
      .where(eq(paymentMethod.id, link.paymentMethodId))
      .limit(1);
    if (!pm) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const [client] = pm.clientId
      ? await deps.db
          .select({ name: clients.name })
          .from(clients)
          .where(eq(clients.id, pm.clientId))
          .limit(1)
      : [];
    const [firm] = await deps.db
      .select({ name: firms.name })
      .from(firms)
      .where(eq(firms.id, link.firmId))
      .limit(1);
    const [brand] = await deps.db
      .select({
        displayName: firmSettings.brandDisplayName,
        logoUrl: firmSettings.brandLogoUrl,
        accentColor: firmSettings.brandAccentColor,
      })
      .from(firmSettings)
      .where(eq(firmSettings.firmId, link.firmId))
      .limit(1);

    await markAchVerifyLinkAccessed(deps.db, link.id).catch((err: unknown) =>
      logger.warn({ err }, 'ach-verify access bump failed'),
    );

    const usable = achVerifyLinkUsable(link);
    // The method may have been verified through another surface (portal,
    // staff dialog, another link) — treat that as the friendly done-state.
    const alreadyVerified = pm.verificationStatus === null || pm.status !== 'ACTIVE';
    res.json({
      bankLabel: pm.displayLabel,
      lastFour: pm.lastFour,
      clientName: client?.name ?? '',
      firm: {
        name: brand?.displayName ?? firm?.name ?? '',
        logoUrl: brand?.logoUrl ?? null,
        accentColor: brand?.accentColor ?? null,
      },
      // 'pending' | 'verified' | 'expired' | 'voided'
      state: usable.ok ? (alreadyVerified ? 'verified' : 'pending') : usable.reason,
    });
  });

  // POST /:token/verify — submit the two amounts (cents) or the SM descriptor
  // code from the bank statement.
  const VerifyBodySchema = z
    .object({
      amounts: z.array(z.number().int().positive().max(99)).length(2).optional(),
      descriptorCode: z.string().trim().min(1).max(40).optional(),
    })
    .refine((v) => Boolean(v.amounts) || Boolean(v.descriptorCode), {
      message: 'amounts_or_descriptor_required',
    });
  router.post('/:token/verify', async (req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    if (
      !(await withinIpLimit(
        deps.redis,
        req,
        res,
        'verify',
        VERIFY_WINDOW_SECONDS,
        VERIFY_MAX_PER_WINDOW,
      ))
    )
      return;
    const link = await loadLink(deps.db, req, res);
    if (!link) return;

    const usable = achVerifyLinkUsable(link);
    if (!usable.ok) {
      res.status(409).json({ error: 'link_not_usable', reason: usable.reason });
      return;
    }
    const parsed = VerifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }

    const [pm] = await deps.db
      .select({
        clientId: paymentMethod.clientId,
        verificationStatus: paymentMethod.verificationStatus,
      })
      .from(paymentMethod)
      .where(eq(paymentMethod.id, link.paymentMethodId))
      .limit(1);
    if (!pm?.clientId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (pm.verificationStatus === null) {
      // Verified elsewhere in the meantime — close the link and celebrate.
      await closeAchVerifyLinks(deps.db, link.paymentMethodId, 'VERIFIED').catch(() => undefined);
      res.json({ ok: true, state: 'verified' });
      return;
    }

    let out;
    try {
      out = await verifyMicrodeposits({
        db: deps.db,
        firmId: link.firmId,
        clientId: pm.clientId,
        paymentMethodId: link.paymentMethodId,
        amounts: parsed.data.amounts as [number, number] | undefined,
        descriptorCode: parsed.data.descriptorCode,
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      logger.error({ err }, 'public ach verify failed');
      res.status(502).json({ error: 'stripe_error' });
      return;
    }
    if (!out.ok) {
      // Wrong amounts/code (or Stripe gave up on the SetupIntent). Don't
      // leak Stripe internals — the page shows a retry-or-contact message.
      res.status(400).json({ error: 'verification_failed' });
      return;
    }

    await closeAchVerifyLinks(deps.db, link.paymentMethodId, 'VERIFIED').catch((err: unknown) =>
      logger.warn({ err }, 'ach-verify link close failed'),
    );
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'payment_method',
      entityId: link.paymentMethodId,
      after: { verification: 'verified', via: 'public_ach_verify_link', linkId: link.id },
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.json({ ok: true, state: 'verified' });
  });

  return router;
}
