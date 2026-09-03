// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// D13a — who gets told about an inbound text: the conversation's assignee;
// else the line's default assignee; else every active user who can read
// the inbox. Recipients are resolved through RBAC (not a role list) so
// per-firm permission overrides are honored. Zod-free.

import { and, eq } from 'drizzle-orm';

import type { PermissionKey } from '@vibe/core/rbac';
import type { Database } from '@vibe/db';
import { appUsers, staffNotifications } from '@vibe/db/schema';

import { getBlockedClientIds } from '../clients/access-resolve';
import { userHasPermission } from '../auth/rbac-resolve';

export const SMS_INBOX_READ_PERMISSION: PermissionKey = 'sms:read';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; ids: string[] }>();

export async function inboxReaderIds(
  db: Database,
  firmId: string,
  now = Date.now(),
): Promise<string[]> {
  const hit = cache.get(firmId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.ids;
  const users = await db
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(and(eq(appUsers.firmId, firmId), eq(appUsers.status, 'ACTIVE')));
  const ids: string[] = [];
  for (const u of users) {
    if (await userHasPermission({ db }, u.id, SMS_INBOX_READ_PERMISSION)) ids.push(u.id);
  }
  cache.set(firmId, { at: now, ids });
  return ids;
}

export function _resetInboxReaderCacheForTests(): void {
  cache.clear();
}

export async function resolveInboundRecipients(
  db: Database,
  args: {
    firmId: string;
    assignedUserId: string | null;
    lineDefaultAssigneeId: string | null;
    /** Set once the conversation is linked, so the 0165 restricted-client
     *  rule can be applied to the fan-out. */
    clientId?: string | null;
  },
): Promise<string[]> {
  const candidates = args.assignedUserId
    ? [args.assignedUserId]
    : args.lineDefaultAssigneeId
      ? [args.lineDefaultAssigneeId]
      : await inboxReaderIds(db, args.firmId);
  if (!args.clientId) return candidates;
  // A notification carries the contact's name and the first 140 characters
  // of the message. Every /api/staff/sms read route 404s a restricted
  // client's conversation for a staffer without access — fanning the
  // content out to them anyway defeated exactly that rule.
  const blocked = new Set<string>();
  for (const id of candidates) {
    const ids = await getBlockedClientIds({ db }, id, args.firmId);
    if (ids.includes(args.clientId)) blocked.add(id);
  }
  return candidates.filter((id) => !blocked.has(id));
}

export async function insertSmsNotifications(
  db: Database,
  args: {
    firmId: string;
    recipients: string[];
    type: 'sms_inbound' | 'sms_reschedule_request' | 'sms_webhook_gap' | 'sms_dead_letter';
    conversationId: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (args.recipients.length === 0) return;
  await db.insert(staffNotifications).values(
    args.recipients.map((rid) => ({
      firmId: args.firmId,
      recipientAppUserId: rid,
      type: args.type,
      entityType: 'sms_conversation',
      entityId: args.conversationId,
      title: args.title,
      body: args.body,
      actionUrl: `/messages?tab=sms&c=${args.conversationId}`,
      metadata: args.metadata ?? {},
    })),
  );
}
