// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 — SMS inbox event fan-out: the publisher writes one JSON envelope
// per event on the per-firm channel the SSE endpoint subscribes to, and
// is a silent no-op without Redis.

import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { createSmsPublisher, smsEventChannel } from '../sms/events';

describe('sms events', () => {
  it('publishes on the firm channel', async () => {
    const pub = new RedisMock() as unknown as Redis;
    const sub = new RedisMock() as unknown as Redis;
    const got: string[] = [];
    await sub.subscribe(smsEventChannel('firm-1'));
    sub.on('message', (_c, m) => got.push(m));
    const publish = createSmsPublisher(pub);
    await publish({
      type: 'sms.message.created',
      firmId: 'firm-1',
      conversationId: 'c1',
      messageId: 'm1',
      clientId: null,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0]!)).toMatchObject({
      type: 'sms.message.created',
      conversationId: 'c1',
    });
  });
  it('is a no-op without redis', async () => {
    await expect(
      createSmsPublisher(null)({
        type: 'sms.conversation.updated',
        firmId: 'f',
        conversationId: 'c',
      }),
    ).resolves.toBeUndefined();
  });
});
