// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Helpers shared by every code path that lets a CLIENT start or join a
// conversation with the firm: the portal "new thread" route and the
// 0235 video-reply route. Keeps the staff-routing rule in one place so
// a client message can never land in a thread nobody at the firm sees.

import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientPortalAccess,
  clients,
  engagementAssignments,
  engagementThreadLinks,
  engagements,
  threadMembers,
  threads,
} from '@vibe/db/schema';

import { provisionThreadForEngagement } from './lifecycle';

/**
 * The "assigned team" for a client: partner-in-charge, every staff member
 * already on one of the client's threads, staff assigned to the client's
 * non-archived engagements — and, when that is empty, every active staff
 * user so the message is never invisible to the firm.
 */
export async function resolveClientThreadStaffIds(
  db: Database,
  args: { firmId: string; clientId: string; partnerInChargeId: string | null },
): Promise<Set<string>> {
  const staffIds = new Set<string>();
  if (args.partnerInChargeId) staffIds.add(args.partnerInChargeId);
  const teamRows = await db
    .selectDistinct({ appUserId: threadMembers.appUserId })
    .from(threadMembers)
    .innerJoin(threads, eq(threads.id, threadMembers.threadId))
    .where(
      and(
        eq(threads.clientId, args.clientId),
        eq(threads.firmId, args.firmId),
        isNull(threadMembers.removedAt),
        isNotNull(threadMembers.appUserId),
      ),
    );
  for (const r of teamRows) if (r.appUserId) staffIds.add(r.appUserId);

  const assignedRows = await db
    .selectDistinct({ appUserId: engagementAssignments.appUserId })
    .from(engagementAssignments)
    .innerJoin(engagements, eq(engagements.id, engagementAssignments.engagementId))
    .where(and(eq(engagements.clientId, args.clientId), ne(engagements.status, 'ARCHIVED')));
  for (const r of assignedRows) staffIds.add(r.appUserId);

  if (staffIds.size === 0) {
    const allStaff = await db
      .select({ id: appUsers.id })
      .from(appUsers)
      .where(and(eq(appUsers.firmId, args.firmId), eq(appUsers.status, 'ACTIVE')));
    for (const s of allStaff) staffIds.add(s.id);
  }
  return staffIds;
}

async function activeMemberIds(
  db: Database,
  threadId: string,
): Promise<{ staff: Set<string>; portal: Set<string> }> {
  const rows = await db
    .select({
      appUserId: threadMembers.appUserId,
      portalIdentityId: threadMembers.portalIdentityId,
    })
    .from(threadMembers)
    .where(and(eq(threadMembers.threadId, threadId), isNull(threadMembers.removedAt)));
  const staff = new Set<string>();
  const portal = new Set<string>();
  for (const r of rows) {
    if (r.appUserId) staff.add(r.appUserId);
    if (r.portalIdentityId) portal.add(r.portalIdentityId);
  }
  return { staff, portal };
}

/**
 * Resolve (creating if needed) the engagement's client-facing thread and
 * make sure both sides can see it: the assigned staff team plus every
 * portal identity with ACTIVE access to the client. Idempotent.
 */
export async function ensureEngagementClientThread(
  db: Database,
  args: { firmId: string; engagementId: string; creatorAppUserId?: string },
): Promise<{ threadId: string; staffIds: Set<string> } | null> {
  const [eng] = await db
    .select({
      id: engagements.id,
      name: engagements.name,
      clientId: engagements.clientId,
      partnerInChargeId: clients.partnerInChargeId,
    })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(and(eq(engagements.id, args.engagementId), eq(clients.firmId, args.firmId)))
    .limit(1);
  if (!eng) return null;

  const [existing] = await db
    .select({ threadId: engagementThreadLinks.threadId })
    .from(engagementThreadLinks)
    .where(eq(engagementThreadLinks.engagementId, eng.id))
    .limit(1);
  const threadId =
    existing?.threadId ??
    (await provisionThreadForEngagement(db, {
      firmId: args.firmId,
      engagementId: eng.id,
      title: eng.name,
      ...(args.creatorAppUserId ? { creatorAppUserId: args.creatorAppUserId } : {}),
    }));
  if (!threadId) return null;

  const staffIds = await resolveClientThreadStaffIds(db, {
    firmId: args.firmId,
    clientId: eng.clientId,
    partnerInChargeId: eng.partnerInChargeId,
  });
  const accessRows = await db
    .select({ identityId: clientPortalAccess.portalIdentityId })
    .from(clientPortalAccess)
    .where(
      and(eq(clientPortalAccess.clientId, eng.clientId), eq(clientPortalAccess.status, 'ACTIVE')),
    );

  const members = await activeMemberIds(db, threadId);
  for (const sid of staffIds) {
    if (members.staff.has(sid)) continue;
    await db.insert(threadMembers).values({
      threadId,
      appUserId: sid,
      memberRole: sid === eng.partnerInChargeId ? 'partner' : 'staff',
    });
  }
  for (const a of accessRows) {
    if (members.portal.has(a.identityId)) continue;
    await db
      .insert(threadMembers)
      .values({ threadId, portalIdentityId: a.identityId, memberRole: 'client' });
  }
  return { threadId, staffIds };
}
