// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R2 — Staff-facing retainer offer + retainer list/detail endpoints.
//
// Mounted at /api/staff/retainers. R5 will extend this with KPI, void,
// dashboard listing, and preview-split endpoints. For R2 we ship the
// minimum needed for partner visibility into auto-created offers.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { retainerOffers, retainers } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';

export interface RetainerRoutesDeps extends RbacDeps {
  db: Database | null;
}

export function createRetainerRouter(deps: RetainerRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // ----- offers ------------------------------------------------------

  router.get(
    '/offers',
    requirePermission(deps, 'retainer:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const conds = [eq(retainerOffers.firmId, session.firmId)];
      const invoiceFilter = uuidQueryParam(req.query['invoiceId']);
      if (invoiceFilter) conds.push(eq(retainerOffers.invoiceId, invoiceFilter));
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      if (status) {
        conds.push(
          eq(
            retainerOffers.status,
            status as 'pending' | 'pending_payment' | 'purchased' | 'declined' | 'expired',
          ),
        );
      }
      const items = await deps.db
        .select()
        .from(retainerOffers)
        .where(and(...conds))
        .orderBy(desc(retainerOffers.createdAt))
        .limit(200);
      res.json({ items });
    },
  );

  router.get(
    '/offers/:id',
    requirePermission(deps, 'retainer:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(retainerOffers)
        .where(
          and(eq(retainerOffers.id, req.params['id']!), eq(retainerOffers.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ offer: row });
    },
  );

  // ----- retainers (read-only for R2; full CRUD in R5) --------------

  router.get('/', requirePermission(deps, 'retainer:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select()
      .from(retainers)
      .where(eq(retainers.firmId, session.firmId))
      .orderBy(desc(retainers.createdAt))
      .limit(200);
    res.json({ items });
  });

  router.get(
    '/:id',
    requirePermission(deps, 'retainer:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(retainers)
        .where(and(eq(retainers.id, req.params['id']!), eq(retainers.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ retainer: row });
    },
  );

  return router;
}
