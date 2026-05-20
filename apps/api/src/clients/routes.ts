// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client management (Phase 6).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, ilike, or } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface ClientRoutesDeps extends RbacDeps {
  db: Database | null;
}

const ClientSchema = z.object({
  name: z.string().min(1).max(200),
  partnerInChargeId: z.string().uuid(),
  billingContactName: z.string().max(200).optional(),
  billingContactEmail: z.string().max(254).optional(),
  billingContactPhone: z.string().max(40).optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  invoiceConsolidationPreference: z.enum(['CONSOLIDATED', 'SEPARATE']).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export function createClientRouter(deps: ClientRoutesDeps): Router {
  const router = express.Router();

  router.get('/', requirePermission(deps, 'client:read'), async (req: Request, res: Response) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ items: [] });
      return;
    }
    const q = (req.query['q'] ?? '').toString().trim();
    const where = q
      ? and(eq(clients.firmId, firmId), or(ilike(clients.name, `%${q}%`)))
      : eq(clients.firmId, firmId);
    const items = await deps.db.select().from(clients).where(where).limit(500);
    res.json({ items });
  });

  router.post('/', requirePermission(deps, 'client:write'), async (req: Request, res: Response) => {
    const parsed = ClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.status(201).json({ ok: true });
      return;
    }
    const [row] = await deps.db
      .insert(clients)
      .values({ firmId, ...parsed.data })
      .returning({ id: clients.id });
    res.status(201).json({ id: row?.id });
  });

  router.patch(
    '/:id/archive',
    requirePermission(deps, 'client:archive'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(clients)
        .set({ status: 'ARCHIVED' })
        .where(and(eq(clients.firmId, firmId), eq(clients.id, req.params['id']!)));
      res.json({ ok: true });
    },
  );

  return router;
}
