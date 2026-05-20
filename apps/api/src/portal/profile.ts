// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Portal identity profile + payment-method endpoints (Phase 16).
// Operations on the session's identity — read profile, update preferences,
// list payment methods, soft-delete a payment method.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clientPortalAccess,
  invoices,
  paymentMethod,
  payments,
  portalIdentity,
} from '@vibe/db/schema';
import { sql as drz } from 'drizzle-orm';

import { logger } from '../logger';

export interface PortalProfileDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

const PreferenceSchema = z.object({
  preferredMethod: z.enum(['EMAIL', 'SMS']).optional(),
  fullName: z.string().min(1).max(200).optional(),
});

export function createPortalProfileRouter(deps: PortalProfileDeps): Router {
  const router = express.Router();

  router.get('/me', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ identity: null });
      return;
    }
    const [identity] = await deps.db
      .select({
        id: portalIdentity.id,
        fullName: portalIdentity.fullName,
        primaryEmail: portalIdentity.primaryEmail,
        primaryPhone: portalIdentity.primaryPhone,
        preferredMethod: portalIdentity.preferredMethod,
        status: portalIdentity.status,
      })
      .from(portalIdentity)
      .where(eq(portalIdentity.id, session.portalIdentityId))
      .limit(1);
    res.json({ identity });
  });

  router.patch('/me', deps.requireAuth, async (req: Request, res: Response) => {
    const parsed = PreferenceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    await deps.db
      .update(portalIdentity)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(portalIdentity.id, session.portalIdentityId));
    res.json({ ok: true });
  });

  router.get('/payment-methods', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select({
        id: paymentMethod.id,
        kind: paymentMethod.kind,
        provider: paymentMethod.provider,
        lastFour: paymentMethod.lastFour,
        displayLabel: paymentMethod.displayLabel,
        brand: paymentMethod.brand,
        expMonth: paymentMethod.expMonth,
        expYear: paymentMethod.expYear,
        isDefault: paymentMethod.isDefault,
        status: paymentMethod.status,
      })
      .from(paymentMethod)
      .where(
        and(
          eq(paymentMethod.portalIdentityId, session.portalIdentityId),
          eq(paymentMethod.status, 'ACTIVE'),
        ),
      );
    res.json({ items });
  });

  router.delete('/payment-methods/:id', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const [pm] = await deps.db
      .select({ id: paymentMethod.id, isDefault: paymentMethod.isDefault })
      .from(paymentMethod)
      .where(
        and(
          eq(paymentMethod.id, req.params['id']!),
          eq(paymentMethod.portalIdentityId, session.portalIdentityId),
        ),
      )
      .limit(1);
    if (!pm) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Soft delete by flipping status — the row is still referenced by
    // historical payments via providerToken lookups, so keep the row.
    await deps.db
      .update(paymentMethod)
      .set({ status: 'REVOKED', isDefault: false, updatedAt: new Date() })
      .where(eq(paymentMethod.id, pm.id));
    logger.info({ paymentMethodId: pm.id }, 'portal payment method removed');
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------
  // Statement of account (Phase 19 #18). All invoices for the active
  // client with paid/outstanding totals.
  // ---------------------------------------------------------------
  router.get('/statement', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ invoices: [], totals: null });
      return;
    }
    if (!session.activeClientId) {
      res.status(400).json({ error: 'no_active_client' });
      return;
    }
    // Confirm the identity actually has access to the active client.
    const [access] = await deps.db
      .select({ clientId: clientPortalAccess.clientId })
      .from(clientPortalAccess)
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
          eq(clientPortalAccess.clientId, session.activeClientId),
          eq(clientPortalAccess.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    if (!access) {
      res.status(403).json({ error: 'client_not_accessible' });
      return;
    }
    const rows = await deps.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        totalCents: invoices.totalCents,
        paidCents: invoices.paidCents,
        status: invoices.status,
      })
      .from(invoices)
      .where(eq(invoices.clientId, session.activeClientId))
      .orderBy(invoices.issueDate);
    const totalBilled = rows.reduce((a, r) => a + Number(r.totalCents), 0);
    const totalPaid = rows.reduce((a, r) => a + Number(r.paidCents), 0);
    res.json({
      invoices: rows,
      totals: {
        billedCents: totalBilled,
        paidCents: totalPaid,
        outstandingCents: totalBilled - totalPaid,
      },
    });
  });

  // ---------------------------------------------------------------
  // Auto-pay enrollment (Phase 19 #17). Sets which payment method
  // should be charged automatically when an invoice posts.
  // ---------------------------------------------------------------
  router.post(
    '/payment-methods/:id/set-autopay',
    deps.requireAuth,
    async (req: Request, res: Response) => {
      const session = req.portalSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [pm] = await deps.db
        .select({ id: paymentMethod.id })
        .from(paymentMethod)
        .where(
          and(
            eq(paymentMethod.id, req.params['id']!),
            eq(paymentMethod.portalIdentityId, session.portalIdentityId),
            eq(paymentMethod.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (!pm) {
        res.status(404).json({ error: 'payment_method_not_found' });
        return;
      }
      // Mark the chosen one as default. Other default-flagged rows are
      // cleared so only one is the autopay target at a time.
      await deps.db.transaction(async (tx) => {
        await tx
          .update(paymentMethod)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(paymentMethod.portalIdentityId, session.portalIdentityId));
        await tx
          .update(paymentMethod)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(paymentMethod.id, pm.id));
      });
      res.json({ ok: true });
    },
  );

  // ---------------------------------------------------------------
  // Recent payments for the active client (Phase 19 #16 — view-only).
  // ---------------------------------------------------------------
  router.get('/payments', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    if (!session.activeClientId) {
      res.status(400).json({ error: 'no_active_client' });
      return;
    }
    const items = await deps.db
      .select({
        id: payments.id,
        amountCents: payments.amountCents,
        refundedAmountCents: payments.refundedAmountCents,
        invoiceId: payments.invoiceId,
        invoiceNumber: invoices.invoiceNumber,
        receivedAt: payments.receivedAt,
        status: payments.status,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(eq(invoices.clientId, session.activeClientId))
      .orderBy(drz`${payments.receivedAt} DESC`)
      .limit(50);
    res.json({ items });
  });

  return router;
}
