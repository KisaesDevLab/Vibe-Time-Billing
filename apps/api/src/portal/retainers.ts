// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R6 — Client portal retainer list + detail + ledger view.
//
// Scoped to session.activeClientId. The ledger response is
// privacy-filtered: strips description, internal staff name, and
// app_user_id. Clients see only date + hours-delta + balance.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { retainerLedger, retainers } from '@vibe/db/schema';

import { addUuidIdGuard } from '../lib/uuid-guard';

export interface PortalRetainerDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

export function createPortalRetainerRouter(deps: PortalRetainerDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select({
        id: retainers.id,
        name: retainers.name,
        returnType: retainers.returnType,
        taxYear: retainers.taxYear,
        tier: retainers.tier,
        hoursPurchased: retainers.hoursPurchased,
        hoursConsumed: retainers.hoursConsumed,
        expiryDate: retainers.expiryDate,
        status: retainers.status,
        purchaseDate: retainers.purchaseDate,
      })
      .from(retainers)
      .where(eq(retainers.clientId, session.activeClientId))
      .orderBy(desc(retainers.createdAt))
      .limit(200);
    res.json({ items });
  });

  router.get('/:id', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const [row] = await deps.db
      .select()
      .from(retainers)
      .where(
        and(eq(retainers.id, req.params['id']!), eq(retainers.clientId, session.activeClientId)),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Privacy-filtered ledger: never include description / staff name /
    // app_user_id. Date + delta + balance + kind only.
    const ledger = await deps.db
      .select({
        id: retainerLedger.id,
        kind: retainerLedger.kind,
        hoursDelta: retainerLedger.hoursDelta,
        hoursBalanceAfter: retainerLedger.hoursBalanceAfter,
        createdAt: retainerLedger.createdAt,
      })
      .from(retainerLedger)
      .where(eq(retainerLedger.retainerId, row.id))
      .orderBy(desc(retainerLedger.createdAt))
      .limit(200);
    res.json({
      retainer: {
        id: row.id,
        name: row.name,
        returnType: row.returnType,
        taxYear: row.taxYear,
        tier: row.tier,
        hoursPurchased: row.hoursPurchased,
        hoursConsumed: row.hoursConsumed,
        expiryDate: row.expiryDate,
        status: row.status,
        purchaseDate: row.purchaseDate,
      },
      ledger,
    });
  });

  return router;
}
