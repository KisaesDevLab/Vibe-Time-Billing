// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP9 — Per-engagement autopay control (Build Plan §2.2).
//
// Three endpoints scoped to session.activeClientId:
//   GET    /api/portal/engagement-autopay
//     Lists active + paused engagements with their current autopay
//     enrollment + the names of accessible payment methods.
//   POST   /api/portal/engagement-autopay/:engagementId
//     Body: { paymentMethodId, pausedUntil? } — enrolls the engagement
//     on the chosen payment method.
//   DELETE /api/portal/engagement-autopay/:engagementId
//     Clears the enrollment (engagement falls back to plan-level
//     autopay or no autopay).
//
// Privacy: only the active client's engagements are visible. Only
// payment methods owned by the signed-in portal identity may be
// enrolled.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { engagements, paymentMethod } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface PortalEngagementAutopayDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

const EnrollSchema = z.object({
  paymentMethodId: z.string().uuid(),
  pausedUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export function createPortalEngagementAutopayRouter(deps: PortalEngagementAutopayDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [], paymentMethods: [] });
      return;
    }
    const items = await deps.db
      .select({
        id: engagements.id,
        name: engagements.name,
        status: engagements.status,
        autopayMethodId: engagements.autopayMethodId,
        autopayPausedUntil: engagements.autopayPausedUntil,
      })
      .from(engagements)
      .where(
        and(
          eq(engagements.clientId, session.activeClientId),
          // Only enrollable while the engagement is live.
          // ACTIVE + PAUSED both expose the toggle.
        ),
      )
      .limit(200);
    const liveItems = items.filter((i) => i.status === 'ACTIVE' || i.status === 'PAUSED');
    const methods = await deps.db
      .select({
        id: paymentMethod.id,
        kind: paymentMethod.kind,
        brand: paymentMethod.brand,
        last4: paymentMethod.lastFour,
        isDefault: paymentMethod.isDefault,
      })
      .from(paymentMethod)
      .where(
        and(
          eq(paymentMethod.portalIdentityId, session.portalIdentityId),
          eq(paymentMethod.status, 'ACTIVE'),
        ),
      );
    res.json({ items: liveItems, paymentMethods: methods });
  });

  router.post('/:engagementId', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const parsed = EnrollSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    // Engagement must belong to the active client.
    const [eng] = await deps.db
      .select({ id: engagements.id, status: engagements.status })
      .from(engagements)
      .where(
        and(
          eq(engagements.id, req.params['engagementId']!),
          eq(engagements.clientId, session.activeClientId),
        ),
      )
      .limit(1);
    if (!eng) {
      res.status(404).json({ error: 'engagement_not_found' });
      return;
    }
    // Payment method must belong to the signed-in identity.
    const [pm] = await deps.db
      .select({ id: paymentMethod.id })
      .from(paymentMethod)
      .where(
        and(
          eq(paymentMethod.id, parsed.data.paymentMethodId),
          eq(paymentMethod.portalIdentityId, session.portalIdentityId),
          eq(paymentMethod.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    if (!pm) {
      res.status(404).json({ error: 'payment_method_not_found' });
      return;
    }
    await deps.db
      .update(engagements)
      .set({
        autopayMethodId: pm.id,
        autopayPausedUntil: parsed.data.pausedUntil ?? null,
        updatedAt: new Date(),
      })
      .where(eq(engagements.id, eng.id));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'engagement',
      entityId: eng.id,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: {
        autopay: 'enrolled',
        paymentMethodId: pm.id,
        pausedUntil: parsed.data.pausedUntil ?? null,
      },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true });
  });

  router.delete('/:engagementId', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [eng] = await deps.db
      .select({ id: engagements.id })
      .from(engagements)
      .where(
        and(
          eq(engagements.id, req.params['engagementId']!),
          eq(engagements.clientId, session.activeClientId),
        ),
      )
      .limit(1);
    if (!eng) {
      res.status(404).json({ error: 'engagement_not_found' });
      return;
    }
    await deps.db
      .update(engagements)
      .set({ autopayMethodId: null, autopayPausedUntil: null, updatedAt: new Date() })
      .where(eq(engagements.id, eng.id));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'engagement',
      entityId: eng.id,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: { autopay: 'unenrolled' },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true });
  });

  return router;
}
