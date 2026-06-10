// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Stage 2 — engagement-level messaging. Distinct from the legacy
// /messaging/ provider config router (which manages SMTP/SMS provider
// rows). Endpoints:
//
//   GET  /threads                              — list threads I belong to
//   GET  /threads/:id                          — thread + members
//   GET  /threads/:id/messages                 — list messages, decrypted
//   POST /threads/:id/messages                 — post new message (encrypts)
//   POST /threads/:id/messages/:msgId/read     — mark read
//   POST /threads/:id/members                  — add member
//   DELETE /threads/:id/members/:memberId      — soft-remove member

import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientPortalAccess,
  clients,
  engagements,
  engagementThreadLinks,
  messageReadReceipts,
  messages,
  portalIdentity,
  threadMembers,
  threads,
  timeEntryMessageLinks,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

import { batchDecryptForThread, encryptForThread, generateWrappedTDek } from './thread-crypto';
import { isMember } from './lifecycle';
import {
  mountThreadAttachmentRoutes,
  listAttachmentsByMessage,
  linkPendingAttachments,
} from '../messaging/attachments';

export interface EngagementMessagingDeps extends RbacDeps {
  db: Database | null;
}

const PostMessageSchema = z.object({
  body: z.string().min(1).max(10_000),
  attachmentIds: z.array(z.string().uuid()).max(20).optional(),
});

const AddMemberSchema = z.object({
  appUserId: z.string().uuid().optional(),
  portalIdentityId: z.string().uuid().optional(),
  memberRole: z.enum(['partner', 'staff', 'client']),
});

const CreateThreadSchema = z.object({
  clientId: z.string().uuid(),
  /** Optional — when set, the new thread is also engagement-linked. */
  engagementId: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  /** Optional first message; sent in the same transaction. */
  body: z.string().min(1).max(10_000).optional(),
  /** Portal identities (client side) to add as members. When omitted,
   *  every ACTIVE client_portal_access for the client is included. */
  portalIdentityIds: z.array(z.string().uuid()).optional(),
});

const AssignEngagementSchema = z.object({
  engagementId: z.string().uuid(),
});

const EXCERPT_MAX = 80;

function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

export function createEngagementMessagingRouter(deps: EngagementMessagingDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['msgId', 'memberId']);

  router.get('/threads', requirePermission(deps, 'messaging:read'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
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
      .leftJoin(engagementThreadLinks, eq(engagementThreadLinks.threadId, threads.id))
      .where(
        and(
          eq(threadMembers.appUserId, session.appUserId),
          isNull(threadMembers.removedAt),
          eq(threads.firmId, session.firmId),
          // 0105 — client messaging lists only client threads; staff-to-staff
          // (kind='internal') belongs to the Team tab, not here.
          eq(threads.kind, 'client'),
        ),
      )
      .orderBy(desc(threads.updatedAt));
    res.json({ items: rows });
  });

  router.get('/threads/:id', requirePermission(deps, 'messaging:read'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const threadId = req.params['id']!;
    if (!(await isMember(deps.db, { threadId, appUserId: session.appUserId }))) {
      res.status(403).json({ error: 'not_a_member' });
      return;
    }
    const [thread] = await deps.db
      .select({
        id: threads.id,
        firmId: threads.firmId,
        clientId: threads.clientId,
        engagementId: engagementThreadLinks.engagementId,
        title: threads.title,
        status: threads.status,
        createdAt: threads.createdAt,
        updatedAt: threads.updatedAt,
      })
      .from(threads)
      .leftJoin(engagementThreadLinks, eq(engagementThreadLinks.threadId, threads.id))
      .where(eq(threads.id, threadId))
      .limit(1);
    if (!thread || thread.firmId !== session.firmId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const members = await deps.db
      .select({
        id: threadMembers.id,
        appUserId: threadMembers.appUserId,
        portalIdentityId: threadMembers.portalIdentityId,
        memberRole: threadMembers.memberRole,
        joinedAt: threadMembers.joinedAt,
        userFullName: appUsers.fullName,
      })
      .from(threadMembers)
      .leftJoin(appUsers, eq(appUsers.id, threadMembers.appUserId))
      .where(and(eq(threadMembers.threadId, threadId), isNull(threadMembers.removedAt)));
    res.json({ thread, members });
  });

  // Assign a client-direct thread to one of the client's engagements.
  // Honors the engagement_thread_link 1:1 constraint: an engagement that
  // already has a thread → 409, and a thread already linked → 409.
  router.post(
    '/threads/:id/engagement',
    requirePermission(deps, 'messaging:write'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const threadId = req.params['id']!;
      const parsed = AssignEngagementSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!(await isMember(deps.db, { threadId, appUserId: session.appUserId }))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      const { engagementId } = parsed.data;
      const [thread] = await deps.db
        .select({ id: threads.id, firmId: threads.firmId, clientId: threads.clientId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      if (!thread || thread.firmId !== session.firmId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [eng] = await deps.db
        .select({ id: engagements.id, engClientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (!eng || eng.engClientId !== thread.clientId) {
        res.status(400).json({ error: 'engagement_client_mismatch' });
        return;
      }
      // Thread already linked?
      const [threadLink] = await deps.db
        .select({ engagementId: engagementThreadLinks.engagementId })
        .from(engagementThreadLinks)
        .where(eq(engagementThreadLinks.threadId, threadId))
        .limit(1);
      if (threadLink) {
        res.status(409).json({ error: 'thread_already_linked' });
        return;
      }
      // Engagement already has a thread?
      const [engLink] = await deps.db
        .select({ threadId: engagementThreadLinks.threadId })
        .from(engagementThreadLinks)
        .where(eq(engagementThreadLinks.engagementId, engagementId))
        .limit(1);
      if (engLink) {
        res.status(409).json({ error: 'engagement_thread_exists', threadId: engLink.threadId });
        return;
      }
      await deps.db
        .insert(engagementThreadLinks)
        .values({ engagementId, threadId })
        .onConflictDoNothing();
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'thread',
        entityId: threadId,
        actorAppUserId: session.appUserId,
        activeClientId: thread.clientId,
        after: { engagementId },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, engagementId });
    },
  );

  router.get(
    '/threads/:id/messages',
    requirePermission(deps, 'messaging:read'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const threadId = req.params['id']!;
      if (!(await isMember(deps.db, { threadId, appUserId: session.appUserId }))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      const limit = Math.min(200, Math.max(1, Number(req.query['limit'] ?? 50)));
      const rows = await deps.db
        .select({
          id: messages.id,
          senderAppUserId: messages.senderAppUserId,
          senderPortalIdentityId: messages.senderPortalIdentityId,
          senderStaffName: appUsers.fullName,
          senderPortalName: portalIdentity.fullName,
          bodyCiphertext: messages.bodyCiphertext,
          excerptPlaintext: messages.excerptPlaintext,
          editOfId: messages.editOfId,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .leftJoin(appUsers, eq(appUsers.id, messages.senderAppUserId))
        .leftJoin(portalIdentity, eq(portalIdentity.id, messages.senderPortalIdentityId))
        .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
        .orderBy(asc(messages.createdAt))
        .limit(limit);
      try {
        const plaintexts = await batchDecryptForThread(
          { db: deps.db, firmId: session.firmId, threadId },
          rows.map((r) => r.bodyCiphertext),
        );
        const attByMsg = await listAttachmentsByMessage(
          deps.db,
          session.firmId,
          threadId,
          rows.map((r) => r.id),
        );
        const items = rows.map((r, i) => ({
          id: r.id,
          senderAppUserId: r.senderAppUserId,
          senderPortalIdentityId: r.senderPortalIdentityId,
          senderName: r.senderStaffName ?? r.senderPortalName ?? null,
          senderKind: r.senderAppUserId ? ('staff' as const) : ('client' as const),
          body: plaintexts[i],
          editOfId: r.editOfId,
          createdAt: r.createdAt,
          attachments: attByMsg.get(r.id) ?? [],
        }));
        res.json({ items });
      } catch (err) {
        logger.error({ err, threadId }, 'message decrypt failed');
        res.status(500).json({ error: 'decrypt_failed' });
      }
    },
  );

  // List every thread visible to the caller for a specific client —
  // both client-direct threads (thread.client_id) and engagement-linked
  // ones (via engagement_thread_link → engagement.client_id). Filtered
  // to threads the staff user is a member of so the response doesn't
  // leak threads outside their assignments.
  router.get(
    '/clients/:clientId/threads',
    requirePermission(deps, 'messaging:read'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const clientId = req.params['clientId']!;
      // Scope check: the client must belong to the caller's firm.
      const [client] = await deps.db
        .select({ id: clients.id, firmId: clients.firmId })
        .from(clients)
        .where(eq(clients.id, clientId))
        .limit(1);
      if (!client || client.firmId !== session.firmId) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      // thread.client_id was backfilled in 0088 for every existing
      // engagement-linked thread, so a single WHERE catches both
      // client-direct and engagement-scoped threads.
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
        .where(
          and(
            eq(threadMembers.appUserId, session.appUserId),
            isNull(threadMembers.removedAt),
            eq(threads.firmId, session.firmId),
            eq(threads.clientId, clientId),
          ),
        )
        .orderBy(desc(threads.updatedAt));
      res.json({ items: rows });
    },
  );

  // Create a new thread at the client scope. When engagementId is set,
  // also writes an engagement_thread_link row (subject to that table's
  // 1:1 constraint — caller gets 409 if the engagement already has a
  // thread). Adds the calling staff user + the named portal identities
  // (or all ACTIVE accesses for the client when omitted) as members.
  // An optional body posts the first message in the same flow so the
  // recipient sees content rather than an empty thread.
  router.post('/threads', requirePermission(deps, 'messaging:write'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = CreateThreadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const { clientId, engagementId, title, body, portalIdentityIds } = parsed.data;

    const [client] = await deps.db
      .select({ id: clients.id, firmId: clients.firmId, name: clients.name })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!client || client.firmId !== session.firmId) {
      res.status(404).json({ error: 'client_not_found' });
      return;
    }

    if (engagementId) {
      const [eng] = await deps.db
        .select({ id: engagements.id, engClientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (!eng || eng.engClientId !== clientId) {
        res.status(400).json({ error: 'engagement_client_mismatch' });
        return;
      }
      const [existingLink] = await deps.db
        .select({ id: engagementThreadLinks.threadId })
        .from(engagementThreadLinks)
        .where(eq(engagementThreadLinks.engagementId, engagementId))
        .limit(1);
      if (existingLink) {
        res.status(409).json({
          error: 'engagement_thread_exists',
          threadId: existingLink.id,
        });
        return;
      }
    }

    // Resolve the portal-identity members. Explicit list wins, but
    // each id must map to an ACTIVE access for THIS client (defense
    // in depth — we don't want a misclicked id to leak the new
    // thread to an identity not authorized for the client).
    const accessRows = await deps.db
      .select({
        identityId: clientPortalAccess.portalIdentityId,
        status: clientPortalAccess.status,
      })
      .from(clientPortalAccess)
      .where(eq(clientPortalAccess.clientId, clientId));
    const activeAccessIds = new Set(
      accessRows.filter((r) => r.status === 'ACTIVE').map((r) => r.identityId),
    );
    const requestedIds = portalIdentityIds
      ? portalIdentityIds.filter((id) => activeAccessIds.has(id))
      : Array.from(activeAccessIds);

    const wrapped = generateWrappedTDek(deps.db, session.firmId);
    let createdThreadId: string | null = null;
    try {
      await deps.db.transaction(async (tx) => {
        const [t] = await tx
          .insert(threads)
          .values({
            firmId: session.firmId,
            clientId,
            tDekWrapped: wrapped,
            title: title ?? `${client.name} — conversation`,
          })
          .returning({ id: threads.id });
        if (!t) throw new Error('thread_insert_failed');
        createdThreadId = t.id;

        if (engagementId) {
          await tx
            .insert(engagementThreadLinks)
            .values({ engagementId, threadId: t.id })
            .onConflictDoNothing();
        }

        // Staff creator → member with role 'staff'.
        await tx
          .insert(threadMembers)
          .values({
            threadId: t.id,
            appUserId: session.appUserId,
            memberRole: 'staff',
          })
          .onConflictDoNothing();

        // Resolved portal identities → 'client' members.
        for (const identityId of requestedIds) {
          await tx
            .insert(threadMembers)
            .values({
              threadId: t.id,
              portalIdentityId: identityId,
              memberRole: 'client',
            })
            .onConflictDoNothing();
        }
      });
    } catch (err) {
      logger.error({ err, clientId, engagementId }, 'thread create failed');
      res.status(500).json({ error: 'thread_create_failed' });
      return;
    }

    const threadId = createdThreadId!;

    // Optional first message — keeps the UI flow single-step.
    if (body && body.trim()) {
      try {
        const ciphertext = await encryptForThread(
          { db: deps.db, firmId: session.firmId, threadId },
          body.trim(),
        );
        await deps.db.insert(messages).values({
          threadId,
          senderAppUserId: session.appUserId,
          bodyCiphertext: ciphertext,
          excerptPlaintext: body.slice(0, EXCERPT_MAX),
        });
        await deps.db
          .update(threads)
          .set({ updatedAt: new Date() })
          .where(eq(threads.id, threadId));
      } catch (err) {
        // Thread is already created; surface the error but leave
        // the empty thread behind for the user to retry.
        logger.error({ err, threadId }, 'first message encrypt failed');
      }
    }

    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'thread',
      entityId: threadId,
      actorAppUserId: session.appUserId,
      activeClientId: clientId,
      after: {
        clientId,
        engagementId: engagementId ?? null,
        memberCount: requestedIds.length + 1,
      },
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.status(201).json({ threadId });
  });

  // Helper: look up the thread linked to a given engagement so the
  // engagement-detail card can fetch messages without knowing the
  // threadId. Returns 404 if no thread exists yet (engagements may
  // pre-date the messaging feature or have had their thread archived).
  router.get(
    '/engagements/:id/thread',
    requirePermission(deps, 'messaging:read'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const engagementId = req.params['id']!;
      const [row] = await deps.db
        .select({
          threadId: threads.id,
          title: threads.title,
          status: threads.status,
          firmId: threads.firmId,
        })
        .from(engagementThreadLinks)
        .innerJoin(threads, eq(threads.id, engagementThreadLinks.threadId))
        .where(eq(engagementThreadLinks.engagementId, engagementId))
        .limit(1);
      if (!row || row.firmId !== session.firmId) {
        res.status(404).json({ error: 'no_thread_for_engagement' });
        return;
      }
      res.json({ threadId: row.threadId, title: row.title, status: row.status });
    },
  );

  router.post(
    '/threads/:id/messages',
    requirePermission(deps, 'messaging:write'),
    async (req, res) => {
      const parsed = PostMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const threadId = req.params['id']!;
      if (!(await isMember(deps.db, { threadId, appUserId: session.appUserId }))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      const [thread] = await deps.db
        .select({ status: threads.status, firmId: threads.firmId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);
      if (!thread || thread.firmId !== session.firmId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (thread.status === 'ARCHIVED') {
        res.status(409).json({ error: 'thread_archived' });
        return;
      }
      try {
        const ciphertext = await encryptForThread(
          { db: deps.db, firmId: session.firmId, threadId },
          parsed.data.body,
        );
        const excerpt = parsed.data.body.slice(0, EXCERPT_MAX);
        const [row] = await deps.db
          .insert(messages)
          .values({
            threadId,
            senderAppUserId: session.appUserId,
            bodyCiphertext: ciphertext,
            excerptPlaintext: excerpt,
          })
          .returning({ id: messages.id, createdAt: messages.createdAt });
        if (row?.id) {
          await linkPendingAttachments(deps.db, threadId, row.id, parsed.data.attachmentIds ?? []);
        }
        await deps.db
          .update(threads)
          .set({ updatedAt: new Date() })
          .where(eq(threads.id, threadId));
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'message',
          entityId: row?.id,
          actorAppUserId: session.appUserId,
          after: { threadId, excerpt },
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.status(201).json({ id: row?.id, createdAt: row?.createdAt });
      } catch (err) {
        logger.error({ err, threadId }, 'message encrypt failed');
        res.status(500).json({ error: 'encrypt_failed' });
      }
    },
  );

  // ============================================================
  // P2.1 — D.5 untracked client interactions
  // GET /threads/:id/untracked-messages?from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&pageSize=50
  // Returns thread messages in the date range that are NOT linked to
  // any time entry. Drives the "Untracked client interactions" panel
  // on the pre-bill review page.
  // ============================================================
  router.get(
    '/threads/:id/untracked-messages',
    requirePermission(deps, 'messaging:read'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], page: 1, pageSize: 50, total: 0 });
        return;
      }
      const threadId = req.params['id']!;
      if (!(await isMember(deps.db, { threadId, appUserId: session.appUserId }))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      const fromRaw = typeof req.query['from'] === 'string' ? req.query['from'] : null;
      const toRaw = typeof req.query['to'] === 'string' ? req.query['to'] : null;
      if ((fromRaw && !DATE_RE.test(fromRaw)) || (toRaw && !DATE_RE.test(toRaw))) {
        res.status(400).json({ error: 'invalid_date' });
        return;
      }
      const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
      const pageSize = Math.min(
        200,
        Math.max(1, parseInt(String(req.query['pageSize'] ?? '50'), 10) || 50),
      );
      // Drizzle's `notInArray` against a sub-select works in pg but the
      // type system fights us; use a raw SQL anti-join for readability.
      const conds = [
        eq(messages.threadId, threadId),
        isNull(messages.deletedAt),
        sql`NOT EXISTS (
          SELECT 1 FROM ${timeEntryMessageLinks}
          WHERE ${timeEntryMessageLinks.messageId} = ${messages.id}
        )`,
      ];
      if (fromRaw) conds.push(sql`${messages.createdAt} >= ${fromRaw}::timestamptz`);
      if (toRaw) conds.push(sql`${messages.createdAt} < (${toRaw}::date + interval '1 day')`);
      const rows = await deps.db
        .select({
          id: messages.id,
          senderAppUserId: messages.senderAppUserId,
          senderPortalIdentityId: messages.senderPortalIdentityId,
          bodyCiphertext: messages.bodyCiphertext,
          excerptPlaintext: messages.excerptPlaintext,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(and(...conds))
        .orderBy(asc(messages.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [countRow] = await deps.db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(messages)
        .where(and(...conds));
      try {
        const plaintexts = await batchDecryptForThread(
          { db: deps.db, firmId: session.firmId, threadId },
          rows.map((r) => r.bodyCiphertext),
        );
        const items = rows.map((r, i) => ({
          id: r.id,
          senderAppUserId: r.senderAppUserId,
          senderPortalIdentityId: r.senderPortalIdentityId,
          body: plaintexts[i],
          createdAt: r.createdAt,
        }));
        res.json({ items, page, pageSize, total: Number(countRow?.c ?? 0) });
      } catch (err) {
        logger.error({ err, threadId }, 'untracked-messages decrypt failed');
        res.status(500).json({ error: 'decrypt_failed' });
      }
    },
  );

  // Convenience for callers that have an engagementId but not the
  // threadId. Resolves and returns the same shape as the thread-keyed
  // route. Easier to wire from the Billing pre-bill UI.
  router.get(
    '/engagements/:engagementId/untracked-messages',
    requirePermission(deps, 'messaging:read'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], page: 1, pageSize: 50, total: 0 });
        return;
      }
      const engagementId = req.params['engagementId']!;
      const [link] = await deps.db
        .select({ threadId: engagementThreadLinks.threadId })
        .from(engagementThreadLinks)
        .where(eq(engagementThreadLinks.engagementId, engagementId))
        .limit(1);
      if (!link) {
        res.json({ items: [], page: 1, pageSize: 50, total: 0, threadId: null });
        return;
      }
      const threadId = link.threadId;
      if (!(await isMember(deps.db, { threadId, appUserId: session.appUserId }))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      const fromRaw = typeof req.query['from'] === 'string' ? req.query['from'] : null;
      const toRaw = typeof req.query['to'] === 'string' ? req.query['to'] : null;
      if ((fromRaw && !DATE_RE.test(fromRaw)) || (toRaw && !DATE_RE.test(toRaw))) {
        res.status(400).json({ error: 'invalid_date' });
        return;
      }
      const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
      const pageSize = Math.min(
        200,
        Math.max(1, parseInt(String(req.query['pageSize'] ?? '50'), 10) || 50),
      );
      const conds = [
        eq(messages.threadId, threadId),
        isNull(messages.deletedAt),
        sql`NOT EXISTS (
          SELECT 1 FROM ${timeEntryMessageLinks}
          WHERE ${timeEntryMessageLinks.messageId} = ${messages.id}
        )`,
      ];
      if (fromRaw) conds.push(sql`${messages.createdAt} >= ${fromRaw}::timestamptz`);
      if (toRaw) conds.push(sql`${messages.createdAt} < (${toRaw}::date + interval '1 day')`);
      const rows = await deps.db
        .select({
          id: messages.id,
          senderAppUserId: messages.senderAppUserId,
          senderPortalIdentityId: messages.senderPortalIdentityId,
          bodyCiphertext: messages.bodyCiphertext,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(and(...conds))
        .orderBy(asc(messages.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [countRow] = await deps.db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(messages)
        .where(and(...conds));
      try {
        const plaintexts = await batchDecryptForThread(
          { db: deps.db, firmId: session.firmId, threadId },
          rows.map((r) => r.bodyCiphertext),
        );
        const items = rows.map((r, i) => ({
          id: r.id,
          senderAppUserId: r.senderAppUserId,
          senderPortalIdentityId: r.senderPortalIdentityId,
          body: plaintexts[i],
          createdAt: r.createdAt,
        }));
        res.json({ items, page, pageSize, total: Number(countRow?.c ?? 0), threadId });
      } catch (err) {
        logger.error({ err, threadId }, 'untracked-messages decrypt failed');
        res.status(500).json({ error: 'decrypt_failed' });
      }
    },
  );

  router.post(
    '/threads/:id/messages/:msgId/read',
    requirePermission(deps, 'messaging:read'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const threadId = req.params['id']!;
      const messageId = req.params['msgId']!;
      if (!(await isMember(deps.db, { threadId, appUserId: session.appUserId }))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      await deps.db
        .insert(messageReadReceipts)
        .values({
          messageId,
          readerAppUserId: session.appUserId,
        })
        .onConflictDoNothing();
      res.json({ ok: true });
    },
  );

  router.post(
    '/threads/:id/members',
    requirePermission(deps, 'messaging:write'),
    async (req, res) => {
      const parsed = AddMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const threadId = req.params['id']!;
      if (!(await isMember(deps.db, { threadId, appUserId: session.appUserId }))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      const data = parsed.data;
      if (!data.appUserId && !data.portalIdentityId) {
        res.status(400).json({ error: 'actor_required' });
        return;
      }
      const [row] = await deps.db
        .insert(threadMembers)
        .values({
          threadId,
          appUserId: data.appUserId ?? null,
          portalIdentityId: data.portalIdentityId ?? null,
          memberRole: data.memberRole,
        })
        .onConflictDoNothing()
        .returning({ id: threadMembers.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'thread_member',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: { threadId, ...data },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.delete(
    '/threads/:id/members/:memberId',
    requirePermission(deps, 'messaging:write'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const threadId = req.params['id']!;
      const memberId = req.params['memberId']!;
      if (!(await isMember(deps.db, { threadId, appUserId: session.appUserId }))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      await deps.db
        .update(threadMembers)
        .set({ removedAt: new Date() })
        .where(
          and(
            eq(threadMembers.id, memberId),
            eq(threadMembers.threadId, threadId),
            isNull(threadMembers.removedAt),
          ),
        );
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'thread_member',
        entityId: memberId,
        actorAppUserId: session.appUserId,
        after: { threadId },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // Suppress unused-import warning for sql when not branching by query
  // shape. Retained for future ordering tweaks.
  void sql;

  // Attachment upload + download/preview (encrypted under the thread T-DEK).
  mountThreadAttachmentRoutes(router, {
    db: deps.db,
    authorize: async (req, threadId) => {
      const s = req.staffSession;
      if (!s || !deps.db) return null;
      if (!(await isMember(deps.db, { threadId, appUserId: s.appUserId }))) return null;
      return { firmId: s.firmId, actorAppUserId: s.appUserId };
    },
  });

  return router;
}
