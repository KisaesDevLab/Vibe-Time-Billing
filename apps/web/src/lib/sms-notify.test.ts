// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { shouldNotifyInbound } from './sms-notify';

describe('shouldNotifyInbound', () => {
  it('dedupes by message id', () => {
    const seen = new Set<string>();
    const evt = { messageId: 'm1', conversationId: 'c1', notifyUserIds: ['me'] };
    expect(shouldNotifyInbound(evt, 'me', seen)).toBe(true);
    expect(shouldNotifyInbound(evt, 'me', seen)).toBe(false);
  });
  it('honors server recipients when present', () => {
    expect(
      shouldNotifyInbound(
        { messageId: 'a', conversationId: 'c', notifyUserIds: ['you'] },
        'me',
        new Set(),
      ),
    ).toBe(false);
    expect(
      shouldNotifyInbound(
        { messageId: 'b', conversationId: 'c', notifyUserIds: ['you', 'me'] },
        'me',
        new Set(),
      ),
    ).toBe(true);
  });
  it('falls back to assignment when recipients are absent', () => {
    expect(
      shouldNotifyInbound(
        { messageId: 'a', conversationId: 'c', assignedUserId: 'you' },
        'me',
        new Set(),
      ),
    ).toBe(false);
    expect(
      shouldNotifyInbound(
        { messageId: 'b', conversationId: 'c', assignedUserId: null },
        'me',
        new Set(),
      ),
    ).toBe(true);
    expect(shouldNotifyInbound({ messageId: 'c', conversationId: 'c' }, null, new Set())).toBe(
      false,
    );
  });
  it('caps the seen set', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++)
      shouldNotifyInbound(
        { messageId: `m${i}`, conversationId: 'c', notifyUserIds: ['me'] },
        'me',
        seen,
      );
    expect(seen.size).toBeLessThanOrEqual(500);
  });
});
