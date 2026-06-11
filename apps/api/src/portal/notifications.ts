// SPDX-License-Identifier: Elastic-2.0
//
// 0146 — portal in-app notifications. Read side of the PORTAL channel
// of the staged-notification pipeline (rows are inserted by the worker
// send job). Every query is scoped to BOTH the portal identity AND the
// session's active client, so a multi-entity identity only sees
// notices for the entity they're switched into.
//
//   GET  /              — list (newest first; ?status=UNREAD|READ)
//   GET  /unread-count  — badge count for the portal nav
//   POST /:id/read      — mark read
//   POST /read-all      — mark all read for the active client

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { portalNotifications } from '@vibe/db/schema';

import { addUuidIdGuard } from '../lib/uuid-guard';

export interface PortalNotificationDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

export function createPortalNotificationRouter(deps: PortalNotificationDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const conds = [
      eq(portalNotifications.portalIdentityId, session.portalIdentityId),
      eq(portalNotifications.clientId, session.activeClientId),
    ];
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
    if (status === 'UNREAD' || status === 'READ') {
      conds.push(eq(portalNotifications.status, status));
    }
    const items = await deps.db
      .select({
        id: portalNotifications.id,
        type: portalNotifications.type,
        title: portalNotifications.title,
        body: portalNotifications.body,
        actionUrl: portalNotifications.actionUrl,
        status: portalNotifications.status,
        createdAt: portalNotifications.createdAt,
        readAt: portalNotifications.readAt,
      })
      .from(portalNotifications)
      .where(and(...conds))
      .orderBy(desc(portalNotifications.createdAt))
      .limit(100);
    res.json({ items });
  });

  router.get('/unread-count', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ count: 0 });
      return;
    }
    const [row] = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(portalNotifications)
      .where(
        and(
          eq(portalNotifications.portalIdentityId, session.portalIdentityId),
          eq(portalNotifications.clientId, session.activeClientId),
          eq(portalNotifications.status, 'UNREAD'),
        ),
      );
    res.json({ count: row?.count ?? 0 });
  });

  router.post('/:id/read', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const [updated] = await deps.db
      .update(portalNotifications)
      .set({ status: 'READ', readAt: new Date() })
      .where(
        and(
          eq(portalNotifications.id, req.params['id']!),
          eq(portalNotifications.portalIdentityId, session.portalIdentityId),
          eq(portalNotifications.clientId, session.activeClientId),
        ),
      )
      .returning({ id: portalNotifications.id });
    if (!updated) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/read-all', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    await deps.db
      .update(portalNotifications)
      .set({ status: 'READ', readAt: new Date() })
      .where(
        and(
          eq(portalNotifications.portalIdentityId, session.portalIdentityId),
          eq(portalNotifications.clientId, session.activeClientId),
          eq(portalNotifications.status, 'UNREAD'),
        ),
      );
    res.json({ ok: true });
  });

  return router;
}
