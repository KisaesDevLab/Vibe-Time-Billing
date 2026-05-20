// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Portal identity profile + payment-method endpoints (Phase 16).
// Operations on the session's identity — read profile, update preferences,
// list payment methods, soft-delete a payment method.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { paymentMethod, portalIdentity } from '@vibe/db/schema';

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

  return router;
}
