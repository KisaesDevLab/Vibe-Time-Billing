// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R3 — Client portal retainer offer endpoints.
//
//   GET    /api/portal/retainer-offers/:id          — render the offer
//   POST   /api/portal/retainer-offers/:id/select   — buy a tier
//   POST   /api/portal/retainer-offers/:id/decline  — say no thanks
//
// Selection creates the retainer-purchase AR invoice (a single RETAINER
// line item) and flips the offer to pending_payment. Paying that
// invoice (Stripe webhook / /payments/receive) calls
// activateRetainerFromPaidInvoice() which writes the retainer row.
//
// Scope: the offer's client_id must match the portal session's
// activeClientId. Offers expire on offer_expires_at (D20); attempting
// to select after that returns 410.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, sql as drz } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clientPortalAccess, invoiceLineItems, invoices, retainerOffers } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface PortalRetainerOfferDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

const SelectSchema = z.object({ tier: z.enum(['TIER_1', 'TIER_2']) });

export function createPortalRetainerOfferRouter(deps: PortalRetainerOfferDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/:id', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const [offer] = await deps.db
      .select()
      .from(retainerOffers)
      .where(eq(retainerOffers.id, req.params['id']!))
      .limit(1);
    if (!offer) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Scope: client must match the active session client.
    if (offer.clientId !== session.activeClientId) {
      // Check whether the identity has ANY access to this client at all;
      // if yes, surface a switch-active hint, else just 404.
      const [access] = await deps.db
        .select({ id: clientPortalAccess.id })
        .from(clientPortalAccess)
        .where(
          and(
            eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
            eq(clientPortalAccess.clientId, offer.clientId),
            eq(clientPortalAccess.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (access) {
        res.status(409).json({ error: 'switch_active_client_required', clientId: offer.clientId });
      } else {
        res.status(404).json({ error: 'not_found' });
      }
      return;
    }
    // Stamp first-view if not already
    res.json({ offer });
  });

  router.post('/:id/select', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const parsed = SelectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [offer] = await deps.db
      .select()
      .from(retainerOffers)
      .where(eq(retainerOffers.id, req.params['id']!))
      .limit(1);
    if (!offer) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (offer.clientId !== session.activeClientId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (offer.status === 'expired' || offer.offerExpiresAt < new Date()) {
      res.status(410).json({ error: 'offer_expired' });
      return;
    }
    if (offer.status !== 'pending') {
      res.status(409).json({ error: 'offer_not_pending', currentStatus: offer.status });
      return;
    }

    const priceCents =
      parsed.data.tier === 'TIER_1' ? offer.tier1PriceCents : offer.tier2PriceCents;
    const invoiceNumber = await nextInvoiceNumber(deps.db, offer.firmId, 'RET');
    const issueDate = new Date().toISOString().slice(0, 10);
    // Due in 14 days for retainer purchases; firm default invoice
    // terms could override but keep simple for v1.
    const dueDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

    const invoiceId = await deps.db.transaction(async (tx) => {
      const [inv] = await tx
        .insert(invoices)
        .values({
          firmId: offer.firmId,
          clientId: offer.clientId,
          primaryEngagementId: offer.engagementId,
          invoiceNumber,
          issueDate,
          dueDate,
          subtotalCents: priceCents,
          totalCents: priceCents,
          status: 'SENT',
          retainerOfferId: offer.id,
        })
        .returning({ id: invoices.id });
      if (!inv) throw new Error('invoice_insert_failed');
      await tx.insert(invoiceLineItems).values({
        invoiceId: inv.id,
        kind: 'RETAINER',
        description: `Retainer purchase — ${parsed.data.tier === 'TIER_1' ? 'Standard' : 'Premium'} coverage for TY${offer.taxYear} ${offer.returnType}`,
        amountCents: priceCents,
        engagementId: offer.engagementId,
        sourceRefType: 'retainer_offer',
        sourceRefId: offer.id,
        sortOrder: 0,
      });
      await tx
        .update(retainerOffers)
        .set({
          status: 'pending_payment',
          purchasedTier: parsed.data.tier,
          purchasedInvoiceId: inv.id,
          updatedAt: new Date(),
        })
        .where(eq(retainerOffers.id, offer.id));
      return inv.id;
    });

    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'retainer_offer',
      entityId: offer.id,
      actorPortalIdentityId: session.portalIdentityId,
      after: { selected: parsed.data.tier, invoiceId, priceCents },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.status(201).json({ invoiceId, invoiceNumber, priceCents });
  });

  router.post('/:id/decline', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [offer] = await deps.db
      .select()
      .from(retainerOffers)
      .where(eq(retainerOffers.id, req.params['id']!))
      .limit(1);
    if (!offer || offer.clientId !== session.activeClientId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (offer.status !== 'pending') {
      res.status(409).json({ error: 'offer_not_pending', currentStatus: offer.status });
      return;
    }
    await deps.db
      .update(retainerOffers)
      .set({ status: 'declined', declinedAt: new Date(), updatedAt: new Date() })
      .where(eq(retainerOffers.id, offer.id));
    // R4-followup — cancel any in-flight reminder jobs so the client
    // doesn't get a follow-up after declining. Best-effort.
    try {
      const { cancelOfferReminders } = await import('../retainers/scheduler');
      void cancelOfferReminders(offer.id);
    } catch (err) {
      logger.error({ err, offerId: offer.id }, 'cancel offer reminders failed');
    }
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'retainer_offer',
      entityId: offer.id,
      actorPortalIdentityId: session.portalIdentityId,
      after: { declined: true },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true });
  });

  return router;
}

async function nextInvoiceNumber(db: Database, firmId: string, prefix: string): Promise<string> {
  const [row] = await db
    .select({
      n: drz<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM '[0-9]+$') AS INTEGER)), 0)`,
    })
    .from(invoices)
    .where(eq(invoices.firmId, firmId));
  const next = Number(row?.n ?? 0) + 1;
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}
