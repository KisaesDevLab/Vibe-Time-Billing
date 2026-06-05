// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-7 — in-app staff notification center. Each row is owned by its
// recipient; a staff member only ever sees/acts on their own. Mounted at
// /api/staff/notifications behind the staff auth chain.
//
//   GET  /                 — list (newest first; ?status= filter)
//   GET  /unread-count     — badge count
//   POST /:id/read         — mark read
//   POST /:id/dismiss      — dismiss
//   POST /read-all         — mark all read

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { staffNotifications } from '@vibe/db/schema';

import { addUuidIdGuard } from '../lib/uuid-guard';

export interface NotificationCenterDeps {
  db: Database | null;
}

export function createNotificationCenterRouter(deps: NotificationCenterDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const conds = [eq(staffNotifications.recipientAppUserId, session.appUserId)];
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
    if (
      status === 'UNREAD' ||
      status === 'READ' ||
      status === 'DISMISSED' ||
      status === 'ACTIONED'
    ) {
      conds.push(eq(staffNotifications.status, status));
    }
    const items = await deps.db
      .select()
      .from(staffNotifications)
      .where(and(...conds))
      .orderBy(desc(staffNotifications.createdAt))
      .limit(100);
    res.json({ items });
  });

  router.get('/unread-count', async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ count: 0 });
      return;
    }
    const [row] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(staffNotifications)
      .where(
        and(
          eq(staffNotifications.recipientAppUserId, session.appUserId),
          eq(staffNotifications.status, 'UNREAD'),
        ),
      );
    res.json({ count: row?.n ?? 0 });
  });

  async function setStatus(
    req: Request,
    res: Response,
    status: 'READ' | 'DISMISSED',
  ): Promise<void> {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    await deps.db
      .update(staffNotifications)
      .set({ status, readAt: status === 'READ' ? new Date() : undefined })
      .where(
        and(
          eq(staffNotifications.id, req.params['id']!),
          eq(staffNotifications.recipientAppUserId, session.appUserId),
        ),
      );
    res.json({ ok: true });
  }

  router.post('/:id/read', (req, res) => void setStatus(req, res, 'READ'));
  router.post('/:id/dismiss', (req, res) => void setStatus(req, res, 'DISMISSED'));

  router.post('/read-all', async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    await deps.db
      .update(staffNotifications)
      .set({ status: 'READ', readAt: new Date() })
      .where(
        and(
          eq(staffNotifications.recipientAppUserId, session.appUserId),
          eq(staffNotifications.status, 'UNREAD'),
        ),
      );
    res.json({ ok: true });
  });

  return router;
}
