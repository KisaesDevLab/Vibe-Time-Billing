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
  args: { firmId: string; assignedUserId: string | null; lineDefaultAssigneeId: string | null },
): Promise<string[]> {
  if (args.assignedUserId) return [args.assignedUserId];
  if (args.lineDefaultAssigneeId) return [args.lineDefaultAssigneeId];
  return inboxReaderIds(db, args.firmId);
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
