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
  engagementThreadLinks,
  messageReadReceipts,
  messages,
  threadMembers,
  threads,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

import { batchDecryptForThread, encryptForThread } from './thread-crypto';
import { isMember } from './lifecycle';

export interface EngagementMessagingDeps extends RbacDeps {
  db: Database | null;
}

const PostMessageSchema = z.object({
  body: z.string().min(1).max(10_000),
});

const AddMemberSchema = z.object({
  appUserId: z.string().uuid().optional(),
  portalIdentityId: z.string().uuid().optional(),
  memberRole: z.enum(['partner', 'staff', 'client']),
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
        title: threads.title,
        status: threads.status,
        createdAt: threads.createdAt,
        updatedAt: threads.updatedAt,
      })
      .from(threads)
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
          bodyCiphertext: messages.bodyCiphertext,
          excerptPlaintext: messages.excerptPlaintext,
          editOfId: messages.editOfId,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
        .orderBy(asc(messages.createdAt))
        .limit(limit);
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
          editOfId: r.editOfId,
          createdAt: r.createdAt,
        }));
        res.json({ items });
      } catch (err) {
        logger.error({ err, threadId }, 'message decrypt failed');
        res.status(500).json({ error: 'decrypt_failed' });
      }
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

  return router;
}
