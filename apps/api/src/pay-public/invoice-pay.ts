// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0181 — public pay-by-link API (open internet surface). Lets a client
// pay an invoice WITHOUT a portal session: the link token is the
// credential. No OTP gate — the action only adds money to the firm's
// own account, and the token is ~128 bits + sha256 at rest + expiry, with
// the invoice-status/balance re-checked at checkout so a paid invoice can
// never be re-charged (multiple active links may coexist).
//
// Routes (all unauthenticated):
//   GET  /api/pay/:token            — safe summary for the landing page
//   POST /api/pay/:token/checkout   — open a Stripe Checkout Session
//   GET  /api/pay/:token/status     — poll link state after redirect
//
// Settlement is NOT recorded here. Stripe Checkout's success redirect is
// not proof of payment; the `checkout.session.completed` webhook records
// the payment into the existing ledger and flips the link to PAID. The
// landing page shows "processing" until that lands.
//
// Enumeration posture (CLAUDE.md #29): an unknown/malformed token gets
// the same 404 {error:'not_found'} as a missing one. Holders of a VALID
// token may learn it is expired/paid/voided (friendly landing states).
// Per-IP rate limits fail OPEN on Redis errors — an infra hiccup must
// not take the public surface down.

import express, { type Request, type Response, type Router, type NextFunction } from 'express';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { invoices, clients, firmSettings, firms, invoicePayLinks } from '@vibe/db/schema';
import type { PaymentProvider } from '@vibe/core/payments';
import { checkAndIncrement } from '@vibe/core/auth';

import { logger } from '../logger';
import { emitAudit } from '../auth/audit';
import {
  resolvePayLink,
  payLinkUsable,
  markPayLinkAccessed,
  type PayLinkRow,
} from '../payments/pay-link-helper';

export interface InvoicePayPublicDeps {
  db: Database | null;
  stripe?: PaymentProvider | null;
  redis?: Redis;
  /** Internet-facing origin used to build the success/cancel URLs. */
  publicBaseUrl: string;
}

const TOKEN_RE = /^[A-Za-z0-9._-]{16,400}$/;

const IP_WINDOW_SECONDS = 60;
const IP_MAX_PER_WINDOW = 60;
const CHECKOUT_MAX_PER_WINDOW = 15;

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
      key: `rl:pay-link:${scope}:${clientIp(req)}`,
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
    logger.warn({ err }, 'pay-link rate limiter error; allowing request');
    return true;
  }
}

/** Resolve + validate the :token param; 404 uniformly on any miss. */
async function loadLink(db: Database, req: Request, res: Response): Promise<PayLinkRow | null> {
  const token = req.params['token'] ?? '';
  if (!TOKEN_RE.test(token)) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const link = await resolvePayLink(db, token);
  if (!link) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return link;
}

export function createInvoicePayPublicRouter(deps: InvoicePayPublicDeps): Router {
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

    const [inv] = await deps.db
      .select({
        invoiceNumber: invoices.invoiceNumber,
        totalCents: invoices.totalCents,
        paidCents: invoices.paidCents,
        status: invoices.status,
        dueDate: invoices.dueDate,
        clientId: invoices.clientId,
      })
      .from(invoices)
      .where(eq(invoices.id, link.invoiceId))
      .limit(1);
    if (!inv) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const [client] = await deps.db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, inv.clientId))
      .limit(1);
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

    await markPayLinkAccessed(deps.db, link.id).catch((err: unknown) =>
      logger.warn({ err }, 'pay-link access bump failed'),
    );

    const balanceCents = Number(inv.totalCents) - Number(inv.paidCents);
    const usable = payLinkUsable(link);
    res.json({
      invoiceNumber: inv.invoiceNumber,
      balanceCents,
      dueDate: inv.dueDate,
      invoiceStatus: inv.status,
      clientName: client?.name ?? '',
      firm: {
        name: brand?.displayName ?? firm?.name ?? '',
        logoUrl: brand?.logoUrl ?? null,
        accentColor: brand?.accentColor ?? null,
      },
      // 'payable' | 'paid' | 'expired' | 'voided' | 'no_balance'
      state: usable.ok ? (balanceCents <= 0 ? 'no_balance' : 'payable') : usable.reason,
    });
  });

  // POST /:token/checkout — open a hosted Checkout Session.
  router.post('/:token/checkout', async (req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    if (!(await withinIpLimit(deps.redis, req, res, 'checkout', 60, CHECKOUT_MAX_PER_WINDOW)))
      return;
    if (!deps.stripe?.createCheckoutSession) {
      res.status(503).json({ error: 'no_payment_provider_configured' });
      return;
    }
    const link = await loadLink(deps.db, req, res);
    if (!link) return;

    const usable = payLinkUsable(link);
    if (!usable.ok) {
      res.status(409).json({ error: 'link_not_payable', reason: usable.reason });
      return;
    }

    const [inv] = await deps.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        totalCents: invoices.totalCents,
        paidCents: invoices.paidCents,
        status: invoices.status,
        firmId: invoices.firmId,
      })
      .from(invoices)
      .where(eq(invoices.id, link.invoiceId))
      .limit(1);
    if (!inv) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (inv.status === 'DRAFT' || inv.status === 'PAID' || inv.status === 'VOIDED') {
      res.status(409).json({ error: 'invoice_not_payable', status: inv.status });
      return;
    }
    const balanceCents = Number(inv.totalCents) - Number(inv.paidCents);
    if (balanceCents <= 0) {
      res.status(409).json({ error: 'no_balance_due' });
      return;
    }

    const token = req.params['token']!;
    const base = deps.publicBaseUrl.replace(/\/$/, '');
    const result = await deps.stripe.createCheckoutSession({
      amountCents: balanceCents,
      currency: 'USD',
      productName: `Invoice ${inv.invoiceNumber}`,
      successUrl: `${base}/pay/${token}/done`,
      cancelUrl: `${base}/pay/${token}`,
      metadata: {
        pay_link_token_hash: link.tokenHash,
        pay_link_id: link.id,
        invoice_id: inv.id,
        invoice_number: inv.invoiceNumber,
        firm_id: inv.firmId,
      },
    });
    if (!result.ok || !result.url) {
      logger.error({ detail: result.errorMessage }, 'checkout session create failed');
      res.status(502).json({ error: 'checkout_failed' });
      return;
    }

    await deps.db
      .update(invoicePayLinks)
      .set({ stripeSessionId: result.sessionId ?? null })
      .where(eq(invoicePayLinks.id, link.id))
      .catch((err: unknown) => logger.warn({ err }, 'pay-link session id store failed'));

    await emitAudit(deps.db, {
      action: 'PAYMENT',
      entityType: 'invoice',
      entityId: inv.id,
      after: { kind: 'pay_link_checkout_opened', payLinkId: link.id, amountCents: balanceCents },
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.json({ url: result.url });
  });

  // GET /:token/status — lightweight poll for the post-redirect page.
  router.get('/:token/status', async (req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const link = await loadLink(deps.db, req, res);
    if (!link) return;
    res.json({ status: link.status, paidAt: link.paidAt });
  });

  return router;
}
