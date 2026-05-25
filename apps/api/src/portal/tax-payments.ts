// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP2 — Client portal tax-payment view.
//
// Scoped to session.activeClientId. Read-only — clients cannot create
// or modify tax payments (staff path only).
//
// Privacy filter:
//   • notes column NEVER returned (firm-internal — they may contain
//     IRS confirmation strategies or other operator-only details)
//   • external_ref NEVER returned (operator-internal sync key)
//   • created_by_id NEVER returned (staff identity)
//
// What clients see: only SCHEDULED + PAID (last 90 days). VOIDED rows
// are hidden — the firm doesn't want noisy "this was cancelled"
// entries cluttering the client view.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, gte, inArray, sql as drz } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { taxPayments } from '@vibe/db/schema';

import { addUuidIdGuard } from '../lib/uuid-guard';
import { resolveScope } from './scope';

export interface PortalTaxPaymentDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

export function createPortalTaxPaymentRouter(deps: PortalTaxPaymentDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const scope = await resolveScope(deps.db, session, req);
    // PAID rows older than 90 days are excluded so the client view
    // stays focused on what's current.
    const cutoffPaid = new Date(Date.now() - 90 * 24 * 3600_000).toISOString().slice(0, 10);
    const items = await deps.db
      .select({
        id: taxPayments.id,
        clientId: taxPayments.clientId,
        engagementId: taxPayments.engagementId,
        jurisdiction: taxPayments.jurisdiction,
        paymentType: taxPayments.paymentType,
        taxYear: taxPayments.taxYear,
        amountCents: taxPayments.amountCents,
        dueDate: taxPayments.dueDate,
        status: taxPayments.status,
        paidDate: taxPayments.paidDate,
        confirmationNumber: taxPayments.confirmationNumber,
      })
      .from(taxPayments)
      .where(
        and(
          inArray(taxPayments.clientId, scope.clientIds),
          // Visible statuses only.
          inArray(taxPayments.status, ['SCHEDULED', 'PAID']),
          // For PAID: only recent. For SCHEDULED: drz wildcard (no cutoff).
          drz`(${taxPayments.status} = 'SCHEDULED' OR ${taxPayments.paidDate} >= ${cutoffPaid})`,
        ),
      )
      .orderBy(taxPayments.dueDate);
    res.json({ items, scope: scope.isConsolidated ? 'all_accessible' : 'active' });
    void gte;
    void eq; // imports kept for future filters
  });

  return router;
}
