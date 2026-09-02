// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { markRowRead, matchesFilter, upsertRow } from './stream-reducer';
import type { SmsConversation } from './types';

function row(over: Partial<SmsConversation> = {}): SmsConversation {
  return {
    id: 'c1',
    lineId: 'l',
    lineLabel: 'Main',
    externalNumberE164: '+13125550148',
    contact: null,
    client: null,
    engagement: null,
    assignedUser: null,
    status: 'open',
    linkSource: 'none',
    needsTriage: false,
    unreadCount: 1,
    lastMessageAt: '2026-09-02T12:00:00Z',
    lastInboundAt: null,
    lastOutboundAt: null,
    lastMessagePreview: 'hi',
    lastDirection: 'inbound',
    pendingReschedule: false,
    createdAt: '2026-09-02T11:00:00Z',
    ...over,
  };
}

describe('sms stream reducer', () => {
  it('filters', () => {
    expect(matchesFilter(row(), 'unread', null)).toBe(true);
    expect(matchesFilter(row({ unreadCount: 0 }), 'unread', null)).toBe(false);
    expect(matchesFilter(row(), 'unassigned', null)).toBe(true);
    expect(
      matchesFilter(row({ client: { id: 'x', name: 'X', restricted: false } }), 'unassigned', null),
    ).toBe(false);
    expect(matchesFilter(row({ needsTriage: true }), 'triage', null)).toBe(true);
    expect(matchesFilter(row({ assignedUser: { id: 'me', name: 'Me' } }), 'mine', 'me')).toBe(true);
    expect(matchesFilter(row({ assignedUser: { id: 'you', name: 'You' } }), 'mine', 'me')).toBe(
      false,
    );
    expect(matchesFilter(row({ status: 'spam' }), 'all', null)).toBe(false);
    expect(matchesFilter(row({ status: 'closed' }), 'all', null)).toBe(true);
  });

  it('upserts new rows to the top by lastMessageAt', () => {
    const state = {
      rows: [row({ id: 'a', lastMessageAt: '2026-09-02T10:00:00Z' })],
      filter: 'all' as const,
      meId: null,
      activeId: null,
    };
    const out = upsertRow(state, row({ id: 'b', lastMessageAt: '2026-09-02T12:00:00Z' }));
    expect(out.map((r) => r.id)).toEqual(['b', 'a']);
    const out2 = upsertRow(
      { ...state, rows: out },
      row({ id: 'a', lastMessageAt: '2026-09-02T13:00:00Z', unreadCount: 2 }),
    );
    expect(out2.map((r) => r.id)).toEqual(['a', 'b']);
    expect(out2[0]!.unreadCount).toBe(2);
  });

  it('drops a row that stops matching the filter unless it is the active one', () => {
    const state = {
      rows: [row({ id: 'a' })],
      filter: 'unread' as const,
      meId: null,
      activeId: null,
    };
    expect(upsertRow(state, row({ id: 'a', unreadCount: 0 }))).toEqual([]);
    expect(
      upsertRow({ ...state, activeId: 'a' }, row({ id: 'a', unreadCount: 0 })).map((r) => r.id),
    ).toEqual(['a']);
  });

  it('markRowRead clears unread only on the target', () => {
    const rows = markRowRead([row({ id: 'a' }), row({ id: 'b' })], 'a');
    expect(rows.map((r) => r.unreadCount)).toEqual([0, 1]);
  });
});
