// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// D13a on the client: decide whether an inbound-text event should raise a
// desktop/browser notification for the signed-in user. DOM-free so it
// unit-tests in node.

export interface InboundNotifyEvent {
  messageId?: string;
  conversationId: string;
  /** server-computed recipients (assignee → line default → all readers) */
  notifyUserIds?: string[];
  assignedUserId?: string | null;
}

const SEEN_CAP = 500;

/**
 * True when this user should be notified for the event. Dedupes on
 * messageId (the SSE stream can redeliver on reconnect). `seen` is
 * mutated: newly-seen ids are appended, oldest evicted past the cap.
 */
export function shouldNotifyInbound(
  evt: InboundNotifyEvent,
  meId: string | null,
  seen: Set<string>,
): boolean {
  if (!meId) return false;
  const key = evt.messageId ?? `${evt.conversationId}:${Date.now()}`;
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_CAP) {
    const first = seen.values().next().value;
    if (first !== undefined) seen.delete(first);
  }
  if (evt.notifyUserIds) return evt.notifyUserIds.includes(meId);
  // Fallback when the server didn't compute recipients: assigned to me, or
  // unassigned (line default unknown here → everyone).
  return !evt.assignedUserId || evt.assignedUserId === meId;
}
