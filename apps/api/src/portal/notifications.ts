// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
import {
  clientRequests,
  engagementLetters,
  engagementThreadLinks,
  engagements,
  files,
  messages,
  portalNotifications,
  threadMembers,
  threads,
  engagementVideoPlays,
  engagementVideos,
} from '@vibe/db/schema';

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

  // 0222 — dashboard "needs your attention" counts, one round trip:
  // unread staff messages, open requests, letters awaiting signature,
  // and client-visible files shared in the last 14 days. Each count is
  // best-effort inside its own try so one bad join can't blank the card.
  router.get('/attention', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({
        unreadMessages: 0,
        openRequests: 0,
        lettersAwaiting: 0,
        newFiles: 0,
        newVideos: 0,
      });
      return;
    }
    const db = deps.db;
    let unreadMessages = 0;
    let openRequests = 0;
    let lettersAwaiting = 0;
    let newFiles = 0;
    let newVideos = 0;

    try {
      // Staff-authored messages in this identity's visible client threads
      // with no read receipt from this identity.
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(threads, eq(threads.id, messages.threadId))
        .innerJoin(threadMembers, eq(threadMembers.threadId, threads.id))
        .leftJoin(engagementThreadLinks, eq(engagementThreadLinks.threadId, threads.id))
        .leftJoin(engagements, eq(engagements.id, engagementThreadLinks.engagementId))
        .where(
          and(
            eq(threadMembers.portalIdentityId, session.portalIdentityId),
            sql`${threadMembers.removedAt} IS NULL`,
            eq(threads.kind, 'client'),
            sql`(${threads.clientId} = ${session.activeClientId} OR ${engagements.clientId} = ${session.activeClientId})`,
            sql`${messages.senderAppUserId} IS NOT NULL`,
            sql`${messages.deletedAt} IS NULL`,
            sql`NOT EXISTS (
              SELECT 1 FROM message_read_receipt mrr
              WHERE mrr.message_id = ${messages.id}
                AND mrr.reader_portal_identity_id = ${session.portalIdentityId}
            )`,
          ),
        );
      unreadMessages = row?.count ?? 0;
    } catch {
      /* best-effort */
    }

    try {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(clientRequests)
        .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
        .where(
          and(
            eq(engagements.clientId, session.activeClientId),
            eq(clientRequests.firmId, session.firmId),
            eq(clientRequests.status, 'OPEN'),
          ),
        );
      openRequests = row?.count ?? 0;
    } catch {
      /* best-effort */
    }

    try {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(engagementLetters)
        .innerJoin(engagements, eq(engagements.id, engagementLetters.engagementId))
        .where(
          and(
            eq(engagements.clientId, session.activeClientId),
            eq(engagementLetters.status, 'SENT'),
          ),
        );
      lettersAwaiting = row?.count ?? 0;
    } catch {
      /* best-effort */
    }

    try {
      const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000);
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(files)
        .where(
          and(
            eq(files.firmId, session.firmId),
            eq(files.clientId, session.activeClientId),
            eq(files.visibility, 'client_visible'),
            eq(files.pendingUpload, false),
            sql`${files.deletedAt} IS NULL`,
            sql`${files.modifiedAt} > ${cutoff.toISOString()}`,
          ),
        );
      newFiles = row?.count ?? 0;
    } catch {
      /* best-effort */
    }

    try {
      // 0235 — available engagement videos this identity has not played.
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(engagementVideos)
        .where(
          and(
            eq(engagementVideos.firmId, session.firmId),
            eq(engagementVideos.clientId, session.activeClientId),
            eq(engagementVideos.status, 'AVAILABLE'),
            sql`NOT EXISTS (
              SELECT 1 FROM ${engagementVideoPlays} p
              WHERE p.video_id = ${engagementVideos.id}
                AND p.portal_identity_id = ${session.portalIdentityId}::uuid
            )`,
          ),
        );
      newVideos = row?.count ?? 0;
    } catch {
      /* best-effort */
    }

    res.json({ unreadMessages, openRequests, lettersAwaiting, newFiles, newVideos });
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
