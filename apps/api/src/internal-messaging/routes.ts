// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Staff-to-staff messaging — direct (1:1) + ad-hoc group threads. Built on
// the same thread/message tables + per-thread T-DEK encryption as client
// messaging, but scoped to kind='internal' (no client). Mounted at
// /api/staff/internal-messaging.
//
// Reads gate on messaging:read, writes on messaging:write (same keys as
// client messaging; all staff roles have both).

import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, messages, threadMembers, threads } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { getApplianceLockState } from '../crypto/boot';
import {
  generateWrappedTDek,
  encryptForThread,
  batchDecryptForThread,
} from '../engagement-messaging/thread-crypto';
import { enqueueMessageNotify, type InternalMessageNotifyJob } from './queue';

export interface InternalMessagingDeps extends RbacDeps {
  db: Database | null;
  /** Override the notify enqueue (tests stub this). */
  enqueueNotify?: (job: InternalMessageNotifyJob) => Promise<void>;
}

const EXCERPT_MAX = 80;

const CreateSchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1).max(50),
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().min(1).max(10_000).optional(),
});
const PostSchema = z.object({ body: z.string().min(1).max(10_000) });
const AddMemberSchema = z.object({ appUserId: z.string().uuid() });

export function createInternalMessagingRouter(deps: InternalMessagingDeps): Router {
  const router = express.Router();
  const enqueue = deps.enqueueNotify ?? enqueueMessageNotify;

  function requireUnlocked(firmId: string, res: Response): boolean {
    const lock = getApplianceLockState();
    if (lock.kind !== 'unlocked' || lock.firmId !== firmId) {
      res.status(503).json({ error: 'appliance_locked' });
      return false;
    }
    return true;
  }

  async function isMember(db: Database, threadId: string, appUserId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: threadMembers.id })
      .from(threadMembers)
      .innerJoin(threads, eq(threads.id, threadMembers.threadId))
      .where(
        and(
          eq(threadMembers.threadId, threadId),
          eq(threadMembers.appUserId, appUserId),
          isNull(threadMembers.removedAt),
          eq(threads.kind, 'internal'),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  // GET /directory — active staff for the new-conversation picker.
  router.get('/directory', requirePermission(deps, 'messaging:read'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ staff: [] });
      return;
    }
    const rows = await deps.db
      .select({ id: appUsers.id, name: appUsers.fullName })
      .from(appUsers)
      .where(
        and(
          eq(appUsers.firmId, session.firmId),
          eq(appUsers.status, 'ACTIVE'),
          ne(appUsers.id, session.appUserId),
        ),
      )
      .orderBy(appUsers.fullName);
    res.json({ staff: rows });
  });

  // Compute unread count per thread for a member (messages after last_read_at
  // not sent by them).
  async function unreadByThread(
    db: Database,
    appUserId: string,
    threadIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (threadIds.length === 0) return out;
    const rows = await db
      .select({
        threadId: messages.threadId,
        n: sql<number>`count(*)::int`,
      })
      .from(messages)
      .innerJoin(threadMembers, eq(threadMembers.threadId, messages.threadId))
      .where(
        and(
          inArray(messages.threadId, threadIds),
          eq(threadMembers.appUserId, appUserId),
          isNull(threadMembers.removedAt),
          isNull(messages.deletedAt),
          ne(messages.senderAppUserId, appUserId),
          sql`(${threadMembers.lastReadAt} IS NULL OR ${messages.createdAt} > ${threadMembers.lastReadAt})`,
        ),
      )
      .groupBy(messages.threadId);
    for (const r of rows) out.set(r.threadId, Number(r.n));
    return out;
  }

  // GET /threads — my internal threads with unread + display label.
  router.get('/threads', requirePermission(deps, 'messaging:read'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ threads: [] });
      return;
    }
    const myRows = await deps.db
      .select({
        threadId: threads.id,
        title: threads.title,
        updatedAt: threads.updatedAt,
        status: threads.status,
      })
      .from(threadMembers)
      .innerJoin(threads, eq(threads.id, threadMembers.threadId))
      .where(
        and(
          eq(threadMembers.appUserId, session.appUserId),
          isNull(threadMembers.removedAt),
          eq(threads.firmId, session.firmId),
          eq(threads.kind, 'internal'),
        ),
      )
      .orderBy(desc(threads.updatedAt));

    const ids = myRows.map((r) => r.threadId);
    const unread = await unreadByThread(deps.db, session.appUserId, ids);

    // Member names (for DM labels) + last excerpt.
    const memberRows = ids.length
      ? await deps.db
          .select({
            threadId: threadMembers.threadId,
            appUserId: threadMembers.appUserId,
            name: appUsers.fullName,
          })
          .from(threadMembers)
          .innerJoin(appUsers, eq(appUsers.id, threadMembers.appUserId))
          .where(and(inArray(threadMembers.threadId, ids), isNull(threadMembers.removedAt)))
      : [];
    const membersByThread = new Map<string, { id: string; name: string }[]>();
    for (const m of memberRows) {
      const list = membersByThread.get(m.threadId) ?? [];
      if (m.appUserId) list.push({ id: m.appUserId, name: m.name });
      membersByThread.set(m.threadId, list);
    }

    const result = myRows.map((r) => {
      const members = membersByThread.get(r.threadId) ?? [];
      const others = members.filter((m) => m.id !== session.appUserId);
      const isDirect = !r.title && members.length === 2;
      const label = r.title ?? (others.map((o) => o.name).join(', ') || 'Conversation');
      return {
        threadId: r.threadId,
        label,
        isDirect,
        memberCount: members.length,
        unread: unread.get(r.threadId) ?? 0,
        updatedAt: r.updatedAt,
        status: r.status,
      };
    });
    res.json({ threads: result });
  });

  // GET /unread-count — total unread across internal threads (nav badge).
  router.get('/unread-count', requirePermission(deps, 'messaging:read'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ unread: 0 });
      return;
    }
    const ids = (
      await deps.db
        .select({ threadId: threads.id })
        .from(threadMembers)
        .innerJoin(threads, eq(threads.id, threadMembers.threadId))
        .where(
          and(
            eq(threadMembers.appUserId, session.appUserId),
            isNull(threadMembers.removedAt),
            eq(threads.firmId, session.firmId),
            eq(threads.kind, 'internal'),
          ),
        )
    ).map((r) => r.threadId);
    const unread = await unreadByThread(deps.db, session.appUserId, ids);
    let total = 0;
    for (const n of unread.values()) total += n;
    res.json({ unread: total });
  });

  // POST /threads — start a DM or group. A 1:1 (one other member, no title)
  // reuses an existing direct thread if one exists.
  router.post('/threads', requirePermission(deps, 'messaging:write'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    if (!requireUnlocked(session.firmId, res)) return;
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    // Validate members are active staff in this firm; always include me.
    const targetIds = Array.from(
      new Set(parsed.data.memberIds.filter((id) => id !== session.appUserId)),
    );
    if (targetIds.length === 0) {
      res.status(400).json({ error: 'no_recipients' });
      return;
    }
    const valid = await deps.db
      .select({ id: appUsers.id })
      .from(appUsers)
      .where(
        and(
          eq(appUsers.firmId, session.firmId),
          eq(appUsers.status, 'ACTIVE'),
          inArray(appUsers.id, targetIds),
        ),
      );
    if (valid.length !== targetIds.length) {
      res.status(400).json({ error: 'invalid_recipient' });
      return;
    }
    const allMembers = [session.appUserId, ...targetIds];

    // Dedupe direct (2-person, untitled) threads.
    if (!parsed.data.title && targetIds.length === 1) {
      const existing = await findDirectThread(
        deps.db,
        session.firmId,
        session.appUserId,
        targetIds[0]!,
      );
      if (existing) {
        if (parsed.data.body) {
          await postMessage(
            deps.db,
            existing,
            session.appUserId,
            session.firmId,
            parsed.data.body,
            enqueue,
          );
        }
        res.status(200).json({ threadId: existing, deduped: true });
        return;
      }
    }

    const wrapped = generateWrappedTDek(deps.db, session.firmId);
    const threadId = await deps.db.transaction(async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({
          firmId: session.firmId,
          tDekWrapped: Buffer.from(wrapped),
          kind: 'internal',
          title: parsed.data.title ?? null,
        })
        .returning({ id: threads.id });
      const tid = t!.id;
      await tx.insert(threadMembers).values(
        allMembers.map((uid) => ({
          threadId: tid,
          appUserId: uid,
          memberRole: 'staff',
        })),
      );
      return tid;
    });

    if (parsed.data.body) {
      await postMessage(
        deps.db,
        threadId,
        session.appUserId,
        session.firmId,
        parsed.data.body,
        enqueue,
      );
    }
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'internal_thread',
      entityId: threadId,
      actorAppUserId: session.appUserId,
      after: { memberCount: allMembers.length, group: Boolean(parsed.data.title) },
    }).catch(() => undefined);

    res.status(201).json({ threadId });
  });

  // GET /threads/:id — detail + members.
  router.get('/threads/:id', requirePermission(deps, 'messaging:read'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const threadId = req.params['id']!;
    if (!(await isMember(deps.db, threadId, session.appUserId))) {
      res.status(403).json({ error: 'not_a_member' });
      return;
    }
    const [thread] = await deps.db
      .select({
        id: threads.id,
        title: threads.title,
        status: threads.status,
        createdAt: threads.createdAt,
      })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);
    const members = await deps.db
      .select({
        id: threadMembers.id,
        appUserId: threadMembers.appUserId,
        name: appUsers.fullName,
      })
      .from(threadMembers)
      .innerJoin(appUsers, eq(appUsers.id, threadMembers.appUserId))
      .where(and(eq(threadMembers.threadId, threadId), isNull(threadMembers.removedAt)));
    res.json({ thread, members });
  });

  // GET /threads/:id/messages — decrypt + mark the thread read.
  router.get(
    '/threads/:id/messages',
    requirePermission(deps, 'messaging:read'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      if (!requireUnlocked(session.firmId, res)) return;
      const threadId = req.params['id']!;
      if (!(await isMember(deps.db, threadId, session.appUserId))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      const limit = Math.min(Number(req.query['limit'] ?? 100) || 100, 200);
      const rows = await deps.db
        .select({
          id: messages.id,
          senderAppUserId: messages.senderAppUserId,
          senderName: appUsers.fullName,
          bodyCiphertext: messages.bodyCiphertext,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .leftJoin(appUsers, eq(appUsers.id, messages.senderAppUserId))
        .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
        .orderBy(desc(messages.createdAt))
        .limit(limit);
      rows.reverse();
      const bodies = await batchDecryptForThread(
        { db: deps.db, firmId: session.firmId, threadId },
        rows.map((r) => r.bodyCiphertext),
      );
      const items = rows.map((r, i) => ({
        id: r.id,
        senderAppUserId: r.senderAppUserId,
        senderName: r.senderName,
        body: bodies[i],
        createdAt: r.createdAt,
        mine: r.senderAppUserId === session.appUserId,
      }));
      // Mark read.
      await deps.db
        .update(threadMembers)
        .set({ lastReadAt: new Date() })
        .where(
          and(eq(threadMembers.threadId, threadId), eq(threadMembers.appUserId, session.appUserId)),
        );
      res.json({ items });
    },
  );

  // POST /threads/:id/messages — send.
  router.post(
    '/threads/:id/messages',
    requirePermission(deps, 'messaging:write'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!requireUnlocked(session.firmId, res)) return;
      const threadId = req.params['id']!;
      if (!(await isMember(deps.db, threadId, session.appUserId))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      const parsed = PostSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const id = await postMessage(
        deps.db,
        threadId,
        session.appUserId,
        session.firmId,
        parsed.data.body,
        enqueue,
      );
      res.status(201).json({ id });
    },
  );

  // POST /threads/:id/read — mark whole thread read.
  router.post('/threads/:id/read', requirePermission(deps, 'messaging:read'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    await deps.db
      .update(threadMembers)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(threadMembers.threadId, req.params['id']!),
          eq(threadMembers.appUserId, session.appUserId),
        ),
      );
    res.json({ ok: true });
  });

  // POST /threads/:id/members — add a staff member (group).
  router.post(
    '/threads/:id/members',
    requirePermission(deps, 'messaging:write'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const threadId = req.params['id']!;
      if (!(await isMember(deps.db, threadId, session.appUserId))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      const parsed = AddMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const [valid] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(
          and(
            eq(appUsers.id, parsed.data.appUserId),
            eq(appUsers.firmId, session.firmId),
            eq(appUsers.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (!valid) {
        res.status(400).json({ error: 'invalid_recipient' });
        return;
      }
      // Reactivate if previously removed, else insert.
      const [existing] = await deps.db
        .select({ id: threadMembers.id, removedAt: threadMembers.removedAt })
        .from(threadMembers)
        .where(
          and(
            eq(threadMembers.threadId, threadId),
            eq(threadMembers.appUserId, parsed.data.appUserId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.removedAt) {
          await deps.db
            .update(threadMembers)
            .set({ removedAt: null, joinedAt: new Date(), lastReadAt: null })
            .where(eq(threadMembers.id, existing.id));
        }
      } else {
        await deps.db
          .insert(threadMembers)
          .values({ threadId, appUserId: parsed.data.appUserId, memberRole: 'staff' });
      }
      res.json({ ok: true });
    },
  );

  // DELETE /threads/:id/members/:memberId — remove (or leave) a member.
  router.delete(
    '/threads/:id/members/:memberId',
    requirePermission(deps, 'messaging:write'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const threadId = req.params['id']!;
      if (!(await isMember(deps.db, threadId, session.appUserId))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      await deps.db
        .update(threadMembers)
        .set({ removedAt: new Date() })
        .where(
          and(
            eq(threadMembers.threadId, threadId),
            eq(threadMembers.appUserId, req.params['memberId']!),
            isNull(threadMembers.removedAt),
          ),
        );
      res.json({ ok: true });
    },
  );

  return router;
}

// ── helpers ───────────────────────────────────────────────────────────

async function findDirectThread(
  db: Database,
  firmId: string,
  a: string,
  b: string,
): Promise<string | null> {
  // Internal, untitled threads that both a and b belong to and which have
  // exactly 2 active members.
  const rows = await db
    .select({ threadId: threads.id })
    .from(threads)
    .where(and(eq(threads.firmId, firmId), eq(threads.kind, 'internal'), isNull(threads.title)));
  for (const { threadId } of rows) {
    const mem = await db
      .select({ appUserId: threadMembers.appUserId })
      .from(threadMembers)
      .where(and(eq(threadMembers.threadId, threadId), isNull(threadMembers.removedAt)));
    const ids = mem.map((m) => m.appUserId);
    if (ids.length === 2 && ids.includes(a) && ids.includes(b)) return threadId;
  }
  return null;
}

async function postMessage(
  db: Database,
  threadId: string,
  senderAppUserId: string,
  firmId: string,
  body: string,
  enqueue: (job: InternalMessageNotifyJob) => Promise<void>,
): Promise<string> {
  const ciphertext = await encryptForThread({ db, firmId, threadId }, body);
  const excerpt = body.slice(0, EXCERPT_MAX);
  const [row] = await db
    .insert(messages)
    .values({
      threadId,
      senderAppUserId,
      bodyCiphertext: Buffer.from(ciphertext),
      excerptPlaintext: excerpt,
    })
    .returning({ id: messages.id });
  const messageId = row!.id;
  await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
  // Sender has implicitly read their own message.
  await db
    .update(threadMembers)
    .set({ lastReadAt: new Date() })
    .where(and(eq(threadMembers.threadId, threadId), eq(threadMembers.appUserId, senderAppUserId)));
  await enqueue({ threadId, messageId, firmId, senderAppUserId }).catch(() => undefined);
  await emitAudit(db, {
    action: 'CREATE',
    entityType: 'message',
    entityId: messageId,
    actorAppUserId: senderAppUserId,
    after: { threadId, internal: true },
  }).catch(() => undefined);
  return messageId;
}
