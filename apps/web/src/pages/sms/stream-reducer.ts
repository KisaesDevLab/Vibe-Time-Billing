// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Pure list-state reducer for the SMS inbox: applies a stream event to the
// currently loaded rows so the panel can update without a refetch. Kept
// DOM-free so it unit-tests in the node vitest environment.

import type { SmsConversation, SmsFilter, SmsStreamEvent } from './types';

export interface ListState {
  rows: SmsConversation[];
  filter: SmsFilter;
  meId: string | null;
  activeId: string | null;
}

/** Whether a row belongs in the given filter view. */
export function matchesFilter(
  row: SmsConversation,
  filter: SmsFilter,
  meId: string | null,
): boolean {
  if (row.status === 'spam') return false;
  switch (filter) {
    case 'unread':
      return row.status === 'open' && row.unreadCount > 0;
    case 'unassigned':
      return row.status === 'open' && !row.client;
    case 'triage':
      return row.status === 'open' && row.needsTriage;
    case 'mine':
      return row.status === 'open' && !!meId && row.assignedUser?.id === meId;
    default:
      return true;
  }
}

function sortRows(rows: SmsConversation[]): SmsConversation[] {
  return [...rows].sort((a, b) => {
    const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
    const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
    return tb - ta;
  });
}

/**
 * Upsert a freshly fetched conversation into the list. Rows that no longer
 * match the filter drop out — except the one the user has open, so the
 * thread doesn't vanish mid-read.
 */
export function upsertRow(state: ListState, fresh: SmsConversation): SmsConversation[] {
  const keep = matchesFilter(fresh, state.filter, state.meId) || fresh.id === state.activeId;
  const without = state.rows.filter((r) => r.id !== fresh.id);
  if (!keep) return without;
  return sortRows([...without, fresh]);
}

/** Which conversation an event refers to, or null for a global refresh. */
export function eventConversationId(evt: SmsStreamEvent): string | null {
  return evt.type === 'sms.refresh' ? null : evt.conversationId;
}

/** Optimistic read: clear unread on the opened row. */
export function markRowRead(rows: SmsConversation[], id: string): SmsConversation[] {
  return rows.map((r) => (r.id === id ? { ...r, unreadCount: 0 } : r));
}
