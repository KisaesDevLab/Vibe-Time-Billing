// SPDX-License-Identifier: Elastic-2.0
//
// Web Push subscription endpoints for the installable portal PWA (Phase 26).
// The portal SPA fetches the VAPID public key, subscribes the browser's
// PushManager, and registers the resulting subscription here against the
// session's portal_identity. The worker sends to these whenever a
// portal_notification is created. No secrets are returned; the private VAPID
// key never leaves the server.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { portalPushSubscription } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { logger } from '../logger';

export interface PortalPushDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  /** VAPID public key (base64url). Absent → push disabled. */
  vapidPublicKey?: string;
  /** True only when both VAPID keys are configured (worker can actually send). */
  pushEnabled: boolean;
}

const SubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

const UnsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });

export function createPortalPushRouter(deps: PortalPushDeps): Router {
  const router = express.Router();

  // Public-to-the-session config: the VAPID public key the browser needs to
  // subscribe, plus whether push is actually wired end-to-end.
  router.get('/key', deps.requireAuth, (_req: Request, res: Response) => {
    res.json({ enabled: deps.pushEnabled, publicKey: deps.vapidPublicKey ?? null });
  });

  router.post('/subscribe', deps.requireAuth, async (req: Request, res: Response) => {
    const parsed = SubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const { endpoint, keys } = parsed.data;
    const userAgent = req.get('user-agent') ?? null;
    // Endpoint is globally unique; upsert so re-subscribing the same browser
    // (or one that moved to a different identity) refreshes the binding and
    // clears any prior failure/disable state.
    await deps.db
      .insert(portalPushSubscription)
      .values({
        firmId: session.firmId,
        portalIdentityId: session.portalIdentityId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent,
        lastUsedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: portalPushSubscription.endpoint,
        set: {
          firmId: session.firmId,
          portalIdentityId: session.portalIdentityId,
          p256dh: keys.p256dh,
          auth: keys.auth,
          userAgent,
          failureCount: 0,
          disabledAt: null,
          lastUsedAt: new Date(),
        },
      });
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'portal_push_subscription',
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId ?? null,
      after: { userAgent },
    }).catch(() => undefined);
    res.status(201).json({ ok: true });
  });

  router.delete('/subscribe', deps.requireAuth, async (req: Request, res: Response) => {
    const parsed = UnsubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    // Scope the delete to the caller's identity so one identity can't remove
    // another's subscription by guessing an endpoint.
    await deps.db
      .delete(portalPushSubscription)
      .where(
        and(
          eq(portalPushSubscription.endpoint, parsed.data.endpoint),
          eq(portalPushSubscription.portalIdentityId, session.portalIdentityId),
        ),
      )
      .catch((err: unknown) => logger.error({ err }, 'push unsubscribe failed'));
    res.json({ ok: true });
  });

  return router;
}
