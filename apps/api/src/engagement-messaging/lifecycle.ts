// SPDX-License-Identifier: Elastic-2.0
//
// Engagement ↔ thread lifecycle. Called from the engagement router on
// create and archive; idempotent so retries don't double-provision.

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clients,
  engagementAssignments,
  engagementThreadLinks,
  engagements,
  threadMembers,
  threads,
} from '@vibe/db/schema';

import { generateWrappedTDek } from './thread-crypto';

export async function provisionThreadForEngagement(
  db: Database,
  args: {
    firmId: string;
    engagementId: string;
    title?: string | null;
    /** App user who initiated the provision. Always added as a thread
     *  member so they can see the thread immediately. Critical when
     *  the creator isn't the client's partner_in_charge and the
     *  engagement has no assignments yet. */
    creatorAppUserId?: string;
  },
): Promise<string | null> {
  // Idempotent — return existing thread id if a link already exists.
  const [existing] = await db
    .select({ threadId: engagementThreadLinks.threadId })
    .from(engagementThreadLinks)
    .where(eq(engagementThreadLinks.engagementId, args.engagementId))
    .limit(1);
  if (existing) return existing.threadId;

  // Denormalize the client_id onto the thread (column added in 0088)
  // so client-scoped queries don't need to traverse the engagement
  // link table.
  const [eng] = await db
    .select({ clientId: engagements.clientId })
    .from(engagements)
    .where(eq(engagements.id, args.engagementId))
    .limit(1);
  const wrapped = generateWrappedTDek(db, args.firmId);
  return await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({
        firmId: args.firmId,
        clientId: eng?.clientId ?? null,
        tDekWrapped: wrapped,
        title: args.title ?? null,
      })
      .returning({ id: threads.id });
    if (!t) return null;
    await tx
      .insert(engagementThreadLinks)
      .values({ engagementId: args.engagementId, threadId: t.id })
      .onConflictDoNothing();
    await syncMembersFromAssignmentsTx(tx, args.engagementId, t.id);
    // Always add the creator if not already a member via assignments
    // or partner_in_charge. Without this an engagement created by a
    // staff member who has no engagement assignment yet AND who isn't
    // the client's partner is orphaned from its own thread.
    if (args.creatorAppUserId) {
      await tx
        .insert(threadMembers)
        .values({
          threadId: t.id,
          appUserId: args.creatorAppUserId,
          memberRole: 'staff',
        })
        .onConflictDoNothing();
    }
    return t.id;
  });
}

/**
 * Mirror engagement_assignment rows into thread_member rows. Idempotent:
 * skips members already present, soft-removes ones that were dropped
 * from the engagement.
 */
export async function syncMembersFromAssignments(
  db: Database,
  engagementId: string,
): Promise<void> {
  const [link] = await db
    .select({ threadId: engagementThreadLinks.threadId })
    .from(engagementThreadLinks)
    .where(eq(engagementThreadLinks.engagementId, engagementId))
    .limit(1);
  if (!link) return;
  await db.transaction((tx) => syncMembersFromAssignmentsTx(tx, engagementId, link.threadId));
}

async function syncMembersFromAssignmentsTx(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  engagementId: string,
  threadId: string,
): Promise<void> {
  // Active engagement assignments → 'staff' thread members.
  const assigned = await tx
    .select({
      appUserId: engagementAssignments.appUserId,
    })
    .from(engagementAssignments)
    .innerJoin(appUsers, eq(appUsers.id, engagementAssignments.appUserId))
    .where(eq(engagementAssignments.engagementId, engagementId));

  for (const row of assigned) {
    await tx
      .insert(threadMembers)
      .values({
        threadId,
        appUserId: row.appUserId,
        memberRole: 'staff',
      })
      .onConflictDoNothing();
  }

  // Client's partner_in_charge → 'partner' thread member. Resolved via
  // the engagement's client row.
  const [partner] = await tx
    .select({ partnerInChargeId: clients.partnerInChargeId })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(eq(engagements.id, engagementId))
    .limit(1);
  if (partner?.partnerInChargeId) {
    await tx
      .insert(threadMembers)
      .values({
        threadId,
        appUserId: partner.partnerInChargeId,
        memberRole: 'partner',
      })
      .onConflictDoNothing();
  }
}

export async function archiveThreadForEngagement(
  db: Database,
  engagementId: string,
): Promise<void> {
  const [link] = await db
    .select({ threadId: engagementThreadLinks.threadId })
    .from(engagementThreadLinks)
    .where(eq(engagementThreadLinks.engagementId, engagementId))
    .limit(1);
  if (!link) return;
  await db
    .update(threads)
    .set({ status: 'ARCHIVED', archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(threads.id, link.threadId), eq(threads.status, 'ACTIVE')));
}

/**
 * Is the given user (staff or portal identity) a thread member?
 * Used by message-post and link-time-entry permission checks.
 */
export async function isMember(
  db: Database,
  args: { threadId: string; appUserId: string } | { threadId: string; portalIdentityId: string },
): Promise<boolean> {
  if ('appUserId' in args) {
    const [row] = await db
      .select({ id: threadMembers.id })
      .from(threadMembers)
      .where(
        and(
          eq(threadMembers.threadId, args.threadId),
          eq(threadMembers.appUserId, args.appUserId),
          isNull(threadMembers.removedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
  const [row] = await db
    .select({ id: threadMembers.id })
    .from(threadMembers)
    .where(
      and(
        eq(threadMembers.threadId, args.threadId),
        eq(threadMembers.portalIdentityId, args.portalIdentityId),
        isNull(threadMembers.removedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function resolveFirmIdForThread(
  db: Database,
  threadId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ firmId: threads.firmId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  return row?.firmId ?? null;
}

// Convenience query: list threads visible to a staff user, with
// engagement context joined. Used by GET /threads.
export async function listThreadsForStaff(
  db: Database,
  args: { firmId: string; appUserId: string },
): Promise<
  Array<{
    threadId: string;
    engagementId: string | null;
    title: string | null;
    status: string;
    updatedAt: Date;
  }>
> {
  const rows = await db
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
        eq(threadMembers.appUserId, args.appUserId),
        isNull(threadMembers.removedAt),
        eq(threads.firmId, args.firmId),
      ),
    )
    .orderBy(sql`${threads.updatedAt} DESC`);
  return rows;
}
