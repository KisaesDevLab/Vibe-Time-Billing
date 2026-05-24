// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Stage 4 — portal-side client-request endpoints. The portal user
// fulfills (or views) requests targeting their active client.

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientRequests, engagements } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

// req.portalSession augmented by portal-middleware.

const FulfillSchema = z.object({
  reason: z.string().max(500).optional(),
  messageId: z.string().uuid().nullable().optional(),
  fileId: z.string().uuid().nullable().optional(),
});

export interface PortalRequestsDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: NextFunction) => unknown;
}

export function createPortalRequestsRouter(deps: PortalRequestsDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);
  router.use(deps.requireAuth);

  router.get('/', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.json({ items: [] });
      return;
    }
    // Active client's engagements → requests on them.
    const rows = await deps.db
      .select({
        id: clientRequests.id,
        engagementId: clientRequests.engagementId,
        title: clientRequests.title,
        body: clientRequests.body,
        status: clientRequests.status,
        dueDate: clientRequests.dueDate,
        fulfilledAt: clientRequests.fulfilledAt,
        createdAt: clientRequests.createdAt,
      })
      .from(clientRequests)
      .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
      .where(eq(engagements.clientId, session.activeClientId))
      .orderBy(desc(clientRequests.createdAt))
      .limit(200);
    res.json({ items: rows });
  });

  router.post('/:id/fulfill', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = FulfillSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    // Scope: caller's active client must own the request's engagement.
    const [request] = await deps.db
      .select({
        requestId: clientRequests.id,
        engagementId: clientRequests.engagementId,
        firmId: clientRequests.firmId,
        status: clientRequests.status,
        clientId: engagements.clientId,
      })
      .from(clientRequests)
      .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
      .where(eq(clientRequests.id, req.params['id']!))
      .limit(1);
    if (!request || request.clientId !== session.activeClientId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (request.status !== 'OPEN') {
      res.status(409).json({ error: 'wrong_status', status: request.status });
      return;
    }
    await deps.db
      .update(clientRequests)
      .set({
        status: 'FULFILLED',
        fulfilledAt: new Date(),
        fulfilledByPortalIdentityId: session.portalIdentityId,
        fulfilledByMessageId: parsed.data.messageId ?? null,
        fulfilledByFileId: parsed.data.fileId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(clientRequests.id, request.requestId));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'client_request',
      entityId: request.requestId,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: {
        kind: 'portal_fulfill',
        messageId: parsed.data.messageId,
        fileId: parsed.data.fileId,
      },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true });
  });

  return router;
}
