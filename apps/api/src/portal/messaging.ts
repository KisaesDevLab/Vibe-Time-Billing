// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Stage 4 — portal-side messaging. Distinct from the staff router; uses
// the portal session middleware and scopes every query to threads the
// portal identity is a member of. Endpoints:
//
//   GET  /threads                                   — list my threads
//   GET  /threads/:id/messages                      — list, decrypted
//   POST /threads/:id/messages                      — post (encrypts)
//   POST /threads/:id/messages/:msgId/read          — mark read

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientPortalAccess,
  engagementThreadLinks,
  engagements,
  messageReadReceipts,
  messages,
  threadMembers,
  threads,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { batchDecryptForThread, encryptForThread } from '../engagement-messaging/thread-crypto';
import {
  mountThreadAttachmentRoutes,
  listAttachmentsByMessage,
  linkPendingAttachments,
} from '../messaging/attachments';

const PostSchema = z.object({
  body: z.string().min(1).max(10_000),
  attachmentIds: z.array(z.string().uuid()).max(20).optional(),
});

// Express.Request is augmented with `portalSession?` by portal-middleware
// — we read it via `req.portalSession`. No local interface needed.

export interface PortalMessagingDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: NextFunction) => unknown;
}

async function memberAndFirmCheck(
  db: Database,
  threadId: string,
  portalIdentityId: string,
  activeClientId: string,
): Promise<{ ok: true; firmId: string } | { ok: false }> {
  // Must be a thread member AND the thread's engagement must belong to
  // the portal identity's active client.
  const [row] = await db
    .select({
      firmId: threads.firmId,
      engagementId: engagementThreadLinks.engagementId,
      clientId: engagements.clientId,
      memberId: threadMembers.id,
    })
    .from(threads)
    .leftJoin(engagementThreadLinks, eq(engagementThreadLinks.threadId, threads.id))
    .leftJoin(engagements, eq(engagements.id, engagementThreadLinks.engagementId))
    .innerJoin(
      threadMembers,
      and(
        eq(threadMembers.threadId, threads.id),
        eq(threadMembers.portalIdentityId, portalIdentityId),
        isNull(threadMembers.removedAt),
      ),
    )
    .where(and(eq(threads.id, threadId), eq(threads.kind, 'client')))
    .limit(1);
  if (!row) return { ok: false };
  if (row.clientId !== activeClientId) return { ok: false };
  return { ok: true, firmId: row.firmId };
}

export function createPortalMessagingRouter(deps: PortalMessagingDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['msgId']);

  router.use(deps.requireAuth);

  router.get('/threads', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.json({ items: [] });
      return;
    }
    // Verify portal_identity has access to the active client (defense
    // in depth — portal middleware already enforces this).
    const [access] = await deps.db
      .select({ clientId: clientPortalAccess.clientId })
      .from(clientPortalAccess)
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
          eq(clientPortalAccess.clientId, session.activeClientId),
        ),
      )
      .limit(1);
    if (!access) {
      res.json({ items: [] });
      return;
    }
    const rows = await deps.db
      .select({
        threadId: threads.id,
        engagementId: engagementThreadLinks.engagementId,
        title: threads.title,
        status: threads.status,
        updatedAt: threads.updatedAt,
      })
      .from(threadMembers)
      .innerJoin(threads, eq(threads.id, threadMembers.threadId))
      .innerJoin(engagementThreadLinks, eq(engagementThreadLinks.threadId, threads.id))
      .innerJoin(engagements, eq(engagements.id, engagementThreadLinks.engagementId))
      .where(
        and(
          eq(threadMembers.portalIdentityId, session.portalIdentityId),
          isNull(threadMembers.removedAt),
          eq(engagements.clientId, session.activeClientId),
          eq(threads.kind, 'client'),
        ),
      )
      .orderBy(desc(threads.updatedAt));
    res.json({ items: rows });
  });

  router.get('/threads/:id/messages', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.json({ items: [] });
      return;
    }
    const threadId = req.params['id']!;
    const check = await memberAndFirmCheck(
      deps.db,
      threadId,
      session.portalIdentityId,
      session.activeClientId,
    );
    if (!check.ok) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const limit = Math.min(200, Math.max(1, Number(req.query['limit'] ?? 50)));
    const rows = await deps.db
      .select({
        id: messages.id,
        senderAppUserId: messages.senderAppUserId,
        senderPortalIdentityId: messages.senderPortalIdentityId,
        bodyCiphertext: messages.bodyCiphertext,
        senderName: appUsers.fullName,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .leftJoin(appUsers, eq(appUsers.id, messages.senderAppUserId))
      .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
      .orderBy(asc(messages.createdAt))
      .limit(limit);
    try {
      const plaintexts = await batchDecryptForThread(
        { db: deps.db, firmId: check.firmId, threadId },
        rows.map((r) => r.bodyCiphertext),
      );
      const attByMsg = await listAttachmentsByMessage(
        deps.db,
        check.firmId,
        threadId,
        rows.map((r) => r.id),
      );
      const items = rows.map((r, i) => ({
        id: r.id,
        senderAppUserId: r.senderAppUserId,
        senderPortalIdentityId: r.senderPortalIdentityId,
        senderName: r.senderName,
        body: plaintexts[i],
        createdAt: r.createdAt,
        // From the client's view, staff-sent messages are "theirs" (right
        // side handled in the UI); expose mine for parity.
        mine:
          Boolean(r.senderPortalIdentityId) &&
          r.senderPortalIdentityId === session.portalIdentityId,
        attachments: attByMsg.get(r.id) ?? [],
      }));
      res.json({ items });
    } catch (err) {
      logger.error({ err, threadId }, 'portal message decrypt failed');
      res.status(500).json({ error: 'decrypt_failed' });
    }
  });

  router.post('/threads/:id/messages', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = PostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const threadId = req.params['id']!;
    const check = await memberAndFirmCheck(
      deps.db,
      threadId,
      session.portalIdentityId,
      session.activeClientId,
    );
    if (!check.ok) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const [thread] = await deps.db
      .select({ status: threads.status })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);
    if (thread?.status === 'ARCHIVED') {
      res.status(409).json({ error: 'thread_archived' });
      return;
    }
    try {
      const ciphertext = await encryptForThread(
        { db: deps.db, firmId: check.firmId, threadId },
        parsed.data.body,
      );
      const [row] = await deps.db
        .insert(messages)
        .values({
          threadId,
          senderPortalIdentityId: session.portalIdentityId,
          bodyCiphertext: ciphertext,
          excerptPlaintext: parsed.data.body.slice(0, 80),
        })
        .returning({ id: messages.id, createdAt: messages.createdAt });
      if (row?.id) {
        await linkPendingAttachments(deps.db, threadId, row.id, parsed.data.attachmentIds ?? []);
      }
      await deps.db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'message',
        entityId: row?.id,
        actorPortalIdentityId: session.portalIdentityId,
        activeClientId: session.activeClientId,
        after: { threadId, excerpt: parsed.data.body.slice(0, 80) },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id, createdAt: row?.createdAt });
    } catch (err) {
      logger.error({ err, threadId }, 'portal message encrypt failed');
      res.status(500).json({ error: 'encrypt_failed' });
    }
  });

  router.post('/threads/:id/messages/:msgId/read', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.json({ ok: true });
      return;
    }
    const threadId = req.params['id']!;
    const check = await memberAndFirmCheck(
      deps.db,
      threadId,
      session.portalIdentityId,
      session.activeClientId,
    );
    if (!check.ok) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    await deps.db
      .insert(messageReadReceipts)
      .values({
        messageId: req.params['msgId']!,
        readerPortalIdentityId: session.portalIdentityId,
      })
      .onConflictDoNothing();
    res.json({ ok: true });
  });

  // Attachment upload + download/preview, scoped to the portal identity's
  // thread membership (and active client). Encrypted under the thread T-DEK.
  mountThreadAttachmentRoutes(router, {
    db: deps.db,
    authorize: async (req, threadId) => {
      const s = req.portalSession;
      if (!s || !deps.db) return null;
      const c = await memberAndFirmCheck(deps.db, threadId, s.portalIdentityId, s.activeClientId);
      return c.ok ? { firmId: c.firmId } : null;
    },
  });

  return router;
}
