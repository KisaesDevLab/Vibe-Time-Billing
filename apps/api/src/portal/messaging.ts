// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
import { and, asc, desc, eq, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { checkAndIncrement } from '@vibe/core/auth';
import type { Database } from '@vibe/db';
import {
  appUsers,
  clientPortalAccess,
  clients,
  engagementAssignments,
  engagementThreadLinks,
  engagements,
  messageReadReceipts,
  messages,
  portalIdentity,
  staffNotifications,
  threadMembers,
  threads,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import {
  batchDecryptForThread,
  encryptForThread,
  generateWrappedTDek,
} from '../engagement-messaging/thread-crypto';
import {
  mountThreadAttachmentRoutes,
  listAttachmentsByMessage,
  linkPendingAttachments,
} from '../messaging/attachments';

const PostSchema = z.object({
  body: z.string().min(1).max(10_000),
  attachmentIds: z.array(z.string().uuid()).max(20).optional(),
});

const StartThreadSchema = z.object({
  body: z.string().min(1).max(10_000),
});

// Express.Request is augmented with `portalSession?` by portal-middleware
// — we read it via `req.portalSession`. No local interface needed.

export interface PortalMessagingDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: NextFunction) => unknown;
  /** Sliding-window rate limit for client-initiated threads. Absent in
   *  some tests; the limiter fails open when missing or erroring. */
  redis?: Redis | null;
}

const NEW_THREAD_MAX_PER_WINDOW = 5;
const NEW_THREAD_WINDOW_SECONDS = 3600;

async function memberAndFirmCheck(
  db: Database,
  threadId: string,
  portalIdentityId: string,
  activeClientId: string,
): Promise<{ ok: true; firmId: string } | { ok: false }> {
  // Must be a thread member AND the thread must belong to the portal
  // identity's active client — either directly (thread.client_id, set on
  // client-direct threads with no engagement) or via its engagement link.
  const [row] = await db
    .select({
      firmId: threads.firmId,
      directClientId: threads.clientId,
      engagementClientId: engagements.clientId,
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
  if (row.directClientId !== activeClientId && row.engagementClientId !== activeClientId) {
    return { ok: false };
  }
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
    // Both client-direct threads (thread.client_id) and engagement-linked
    // ones (engagement.client_id) for the active client. thread.client_id
    // was backfilled in 0088 for existing engagement threads, but the
    // engagement OR keeps any legacy null-client_id thread visible too.
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
      .leftJoin(engagementThreadLinks, eq(engagementThreadLinks.threadId, threads.id))
      .leftJoin(engagements, eq(engagements.id, engagementThreadLinks.engagementId))
      .where(
        and(
          eq(threadMembers.portalIdentityId, session.portalIdentityId),
          isNull(threadMembers.removedAt),
          eq(threads.kind, 'client'),
          or(
            eq(threads.clientId, session.activeClientId),
            eq(engagements.clientId, session.activeClientId),
          ),
        ),
      )
      .orderBy(desc(threads.updatedAt));
    res.json({ items: rows });
  });

  // Client-initiated thread. No engagement required — the firm can assign
  // one later from the staff Messages view. Routes to the right staff:
  // the client's partner-in-charge plus the "assigned team" (any staff
  // already on this client's threads), falling back to the firm default
  // partner-in-charge, then every active staff user, so the firm always
  // sees the message.
  router.post('/threads', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = StartThreadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const db = deps.db;
    const { activeClientId, portalIdentityId, firmId } = session;

    // Sliding-window rate limit — a client shouldn't be able to mass-create
    // threads (each wraps a T-DEK + fans out members + notifications).
    // Fails open on Redis trouble: messaging the firm must not break
    // because the limiter is down.
    if (deps.redis) {
      try {
        const limit = await checkAndIncrement(deps.redis, {
          key: `rl:portal-thread:${portalIdentityId}`,
          max: NEW_THREAD_MAX_PER_WINDOW,
          windowSeconds: NEW_THREAD_WINDOW_SECONDS,
        });
        if (!limit.allowed) {
          res.setHeader('Retry-After', String(limit.retryAfterSeconds));
          res.status(429).json({ error: 'rate_limited' });
          return;
        }
      } catch (err) {
        logger.warn({ err }, 'portal thread rate limiter error; allowing');
      }
    }

    // Defense in depth — the identity must have access to the active client.
    const [access] = await db
      .select({ clientId: clientPortalAccess.clientId })
      .from(clientPortalAccess)
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, portalIdentityId),
          eq(clientPortalAccess.clientId, activeClientId),
          eq(clientPortalAccess.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    if (!access) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const [client] = await db
      .select({ id: clients.id, name: clients.name, partnerInChargeId: clients.partnerInChargeId })
      .from(clients)
      .where(and(eq(clients.id, activeClientId), eq(clients.firmId, firmId)))
      .limit(1);
    if (!client) {
      res.status(404).json({ error: 'client_not_found' });
      return;
    }

    const [me] = await db
      .select({ fullName: portalIdentity.fullName })
      .from(portalIdentity)
      .where(eq(portalIdentity.id, portalIdentityId))
      .limit(1);

    // Resolve the staff recipients (the "assigned team").
    const staffIds = new Set<string>();
    if (client.partnerInChargeId) staffIds.add(client.partnerInChargeId);
    const teamRows = await db
      .selectDistinct({ appUserId: threadMembers.appUserId })
      .from(threadMembers)
      .innerJoin(threads, eq(threads.id, threadMembers.threadId))
      .where(
        and(
          eq(threads.clientId, activeClientId),
          eq(threads.firmId, firmId),
          isNull(threadMembers.removedAt),
          isNotNull(threadMembers.appUserId),
        ),
      );
    for (const r of teamRows) if (r.appUserId) staffIds.add(r.appUserId);

    // …plus staff assigned to the client's non-archived engagements — they
    // are part of the working team even if they haven't messaged yet.
    const assignedRows = await db
      .selectDistinct({ appUserId: engagementAssignments.appUserId })
      .from(engagementAssignments)
      .innerJoin(engagements, eq(engagements.id, engagementAssignments.engagementId))
      .where(and(eq(engagements.clientId, activeClientId), ne(engagements.status, 'ARCHIVED')));
    for (const r of assignedRows) staffIds.add(r.appUserId);

    if (staffIds.size === 0) {
      // No partner-in-charge and no prior team — fall back to every active
      // staff user so a client message is never invisible to the firm.
      const allStaff = await db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.firmId, firmId), eq(appUsers.status, 'ACTIVE')));
      for (const s of allStaff) staffIds.add(s.id);
    }

    const wrapped = generateWrappedTDek(db, firmId);
    // Date suffix keeps repeat conversations from the same contact
    // distinguishable in both the staff and portal thread lists.
    const today = new Date().toISOString().slice(0, 10);
    const title = me?.fullName
      ? `${me.fullName} (${client.name}) — ${today}`
      : `${client.name} — client message ${today}`;
    let createdThreadId: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const [t] = await tx
          .insert(threads)
          .values({ firmId, clientId: activeClientId, tDekWrapped: wrapped, title })
          .returning({ id: threads.id });
        if (!t) throw new Error('thread_insert_failed');
        createdThreadId = t.id;

        // The initiating client.
        await tx
          .insert(threadMembers)
          .values({ threadId: t.id, portalIdentityId, memberRole: 'client' })
          .onConflictDoNothing();

        // Staff recipients — partner-in-charge gets 'partner', rest 'staff'.
        for (const sid of staffIds) {
          await tx
            .insert(threadMembers)
            .values({
              threadId: t.id,
              appUserId: sid,
              memberRole: sid === client.partnerInChargeId ? 'partner' : 'staff',
            })
            .onConflictDoNothing();
        }
      });
    } catch (err) {
      logger.error({ err, clientId: activeClientId }, 'portal thread create failed');
      res.status(500).json({ error: 'thread_create_failed' });
      return;
    }

    const threadId = createdThreadId!;
    try {
      const ciphertext = await encryptForThread({ db, firmId, threadId }, parsed.data.body);
      await db.insert(messages).values({
        threadId,
        senderPortalIdentityId: portalIdentityId,
        bodyCiphertext: ciphertext,
        excerptPlaintext: parsed.data.body.slice(0, 80),
      });
      await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
    } catch (err) {
      logger.error({ err, threadId }, 'portal first message encrypt failed');
    }

    // In-app notification so the routed staff actually see the new
    // conversation without having to open the client's Messages card.
    try {
      const senderName = me?.fullName ?? 'A client contact';
      await db.insert(staffNotifications).values(
        [...staffIds].map((sid) => ({
          firmId,
          recipientAppUserId: sid,
          type: 'client_message_thread',
          entityType: 'thread',
          entityId: threadId,
          title: `New message from ${senderName} (${client.name})`,
          body: parsed.data.body.slice(0, 160),
          actionUrl: `/clients/${activeClientId}`,
        })),
      );
    } catch (err) {
      logger.error({ err, threadId }, 'client thread staff notification failed');
    }

    await emitAudit(db, {
      action: 'CREATE',
      entityType: 'thread',
      entityId: threadId,
      actorPortalIdentityId: portalIdentityId,
      activeClientId,
      after: { clientId: activeClientId, staffMemberCount: staffIds.size, clientInitiated: true },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.status(201).json({ threadId });
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
