// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-2 — the four "new stuff" counters the staff Shell shows in its nav
// (team messages, notification center, client responses on requests,
// unread intake submissions), factored so the SSE event stream
// (staff-events.ts) can compute them server-side on one connection
// instead of the browser polling four endpoints every 30 s.
//
// Each counter mirrors the query its REST endpoint runs — keep them in
// step with internal-messaging/routes.ts (/unread-count),
// notifications/center-routes.ts (/unread-count), requests/routes.ts
// (/client-responses/unread-count) and intake/staff-routes.ts (/count).

import { and, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clientRequests,
  engagements,
  intakeSessions,
  messages,
  staffNotifications,
  threadMembers,
  threads,
} from '@vibe/db/schema';
import type { PermissionKey } from '@vibe/core/rbac';

import { getBlockedClientIds } from '../clients/access';

export interface StaffCounts {
  teamUnread: number;
  notifUnread: number;
  requestsNew: number;
  intakeNew: number;
}

export const EMPTY_COUNTS: StaffCounts = {
  teamUnread: 0,
  notifUnread: 0,
  requestsNew: 0,
  intakeNew: 0,
};

export interface CountsSubject {
  appUserId: string;
  firmId: string;
  /** Effective permission set — counters the user may not see stay 0. */
  perms: ReadonlySet<PermissionKey>;
}

async function countTeamUnread(db: Database, s: CountsSubject): Promise<number> {
  const ids = (
    await db
      .select({ threadId: threads.id })
      .from(threadMembers)
      .innerJoin(threads, eq(threads.id, threadMembers.threadId))
      .where(
        and(
          eq(threadMembers.appUserId, s.appUserId),
          isNull(threadMembers.removedAt),
          eq(threads.firmId, s.firmId),
          eq(threads.kind, 'internal'),
        ),
      )
  ).map((r) => r.threadId);
  if (ids.length === 0) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(threadMembers, eq(threadMembers.threadId, messages.threadId))
    .where(
      and(
        inArray(messages.threadId, ids),
        eq(threadMembers.appUserId, s.appUserId),
        isNull(threadMembers.removedAt),
        isNull(messages.deletedAt),
        ne(messages.senderAppUserId, s.appUserId),
        sql`(${threadMembers.lastReadAt} IS NULL OR ${messages.createdAt} > ${threadMembers.lastReadAt})`,
      ),
    );
  return Number(row?.n ?? 0);
}

async function countNotifUnread(db: Database, s: CountsSubject): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(staffNotifications)
    .where(
      and(
        eq(staffNotifications.recipientAppUserId, s.appUserId),
        eq(staffNotifications.status, 'UNREAD'),
      ),
    );
  return Number(row?.n ?? 0);
}

async function countRequestsNew(db: Database, s: CountsSubject): Promise<number> {
  const conds = [
    eq(clientRequests.firmId, s.firmId),
    sql`${clientRequests.clientReplyText} IS NOT NULL`,
    isNull(clientRequests.clientReplySeenAt),
    inArray(clientRequests.status, ['OPEN', 'NEEDS_INFO']),
  ];
  const blocked = await getBlockedClientIds({ db }, s.appUserId, s.firmId);
  if (blocked.length) {
    const blockedEngs = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(inArray(engagements.clientId, blocked));
    if (blockedEngs.length) {
      conds.push(
        notInArray(
          clientRequests.engagementId,
          blockedEngs.map((e) => e.id),
        ),
      );
    }
  }
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(clientRequests)
    .where(and(...conds));
  return Number(row?.n ?? 0);
}

async function countIntakeNew(db: Database, s: CountsSubject): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(intakeSessions)
    .where(
      and(
        eq(intakeSessions.firmId, s.firmId),
        eq(intakeSessions.status, 'received'),
        isNull(intakeSessions.readAt),
      ),
    );
  return Number(row?.n ?? 0);
}

/** All four counters, permission-gated exactly like the nav badges. */
export async function loadStaffCounts(db: Database, s: CountsSubject): Promise<StaffCounts> {
  const [teamUnread, notifUnread, requestsNew, intakeNew] = await Promise.all([
    s.perms.has('messaging:read') ? countTeamUnread(db, s) : Promise.resolve(0),
    countNotifUnread(db, s),
    s.perms.has('requests:read') ? countRequestsNew(db, s) : Promise.resolve(0),
    s.perms.has('storage:folder:view') ? countIntakeNew(db, s) : Promise.resolve(0),
  ]);
  return { teamUnread, notifUnread, requestsNew, intakeNew };
}
