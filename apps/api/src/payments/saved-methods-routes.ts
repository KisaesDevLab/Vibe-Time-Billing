// SPDX-License-Identifier: Elastic-2.0
//
// Staff API for a client's saved payment methods (card / ACH bank). The
// browser drives the Stripe Payment Element with the client_secret returned
// by /setup-intent, then posts the setup-intent id back to /confirm so the
// server persists the method. Mounted at /api/staff/payment-methods.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { paymentMethod } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { getBlockedClientIdsCached } from '../clients/access';
import { emitAudit } from '../auth/audit';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import {
  confirmClientSetupIntent,
  createClientSetupIntent,
  listClientMethods,
} from './saved-methods';

export interface SavedMethodsDeps extends RbacDeps {
  db: Database | null;
}

async function clientBlocked(
  deps: SavedMethodsDeps,
  req: Request,
  clientId: string,
): Promise<boolean> {
  const s = req.staffSession!;
  const blocked = await getBlockedClientIdsCached(deps, req, s.appUserId, s.firmId);
  return blocked.includes(clientId);
}

export function createSavedMethodsRouter(deps: SavedMethodsDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // Begin a save flow — returns the SetupIntent client_secret + publishable key.
  const SetupSchema = z.object({ clientId: z.string().uuid() });
  router.post(
    '/setup-intent',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = SetupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      if (await clientBlocked(deps, req, parsed.data.clientId)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const r = await createClientSetupIntent(
        deps.db,
        req.staffSession!.firmId,
        parsed.data.clientId,
      );
      if ('error' in r) {
        res.status(r.error === 'client_not_found' ? 404 : 400).json({ error: r.error });
        return;
      }
      res.json(r);
    },
  );

  // Persist the method after the browser confirms the SetupIntent.
  const ConfirmSchema = z.object({
    clientId: z.string().uuid(),
    setupIntentId: z.string().min(1).max(120),
    mandateText: z.string().max(20_000).optional(),
  });
  router.post(
    '/confirm',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ConfirmSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const s = req.staffSession!;
      if (await clientBlocked(deps, req, parsed.data.clientId)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      let out;
      try {
        out = await confirmClientSetupIntent(
          deps.db,
          s.firmId,
          parsed.data.clientId,
          parsed.data.setupIntentId,
          { mandateText: parsed.data.mandateText },
        );
      } catch (err) {
        logger.error({ err }, 'saved-method confirm failed');
        res.status(502).json({ error: 'stripe_error' });
        return;
      }
      if (!out.ok) {
        res.status(400).json({ error: out.error });
        return;
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'payment_method',
        entityId: out.paymentMethodId,
        actorAppUserId: s.appUserId,
        after: { clientId: parsed.data.clientId, kind: 'saved' },
      }).catch(() => undefined);
      res.status(201).json({ ok: true, paymentMethodId: out.paymentMethodId });
    },
  );

  // List a client's active saved methods.
  router.get('/', requirePermission(deps, 'payment:read'), async (req: Request, res: Response) => {
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const clientId = typeof req.query['clientId'] === 'string' ? req.query['clientId'] : '';
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) {
      res.status(400).json({ error: 'invalid_client_id' });
      return;
    }
    if (await clientBlocked(deps, req, clientId)) {
      res.json({ items: [] });
      return;
    }
    const items = await listClientMethods(deps.db, req.staffSession!.firmId, clientId);
    res.json({ items });
  });

  // Revoke (soft) a saved method.
  router.delete(
    '/:id',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      const [row] = await deps.db
        .update(paymentMethod)
        .set({ status: 'REVOKED', updatedAt: new Date() })
        .where(and(eq(paymentMethod.id, req.params['id']!), eq(paymentMethod.firmId, firmId)))
        .returning({ id: paymentMethod.id });
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'payment_method',
        entityId: row.id,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
