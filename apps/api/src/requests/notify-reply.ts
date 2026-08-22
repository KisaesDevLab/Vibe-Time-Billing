// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-2 — when a client answers a request from the portal, tell the staffer
// who owns it (assignee, else creator) through the notification center so
// the desktop shell can toast it with the client's name and a deep link.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientRequests, clients, engagements, staffNotifications } from '@vibe/db/schema';

import { pokeStaffEvents } from '../notifications/staff-events-bus';

export async function notifyRequestClientReply(
  db: Database,
  requestId: string,
  kind: 'reply' | 'needs_info',
): Promise<void> {
  const [row] = await db
    .select({
      firmId: clientRequests.firmId,
      title: clientRequests.title,
      assignee: clientRequests.assignedAppUserId,
      creator: clientRequests.createdByAppUserId,
      clientName: clients.name,
    })
    .from(clientRequests)
    .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(eq(clientRequests.id, requestId))
    .limit(1);
  if (!row) return;
  const recipient = row.assignee ?? row.creator;
  if (!recipient) return;
  await db.insert(staffNotifications).values({
    firmId: row.firmId,
    recipientAppUserId: recipient,
    type: kind === 'reply' ? 'request_client_reply' : 'request_needs_info',
    entityType: 'client_request',
    entityId: requestId,
    title:
      kind === 'reply'
        ? `${row.clientName} responded to a request`
        : `${row.clientName} needs more info on a request`,
    body: row.title,
    actionUrl: `/requests/${requestId}`,
  });
  pokeStaffEvents([recipient]);
}
