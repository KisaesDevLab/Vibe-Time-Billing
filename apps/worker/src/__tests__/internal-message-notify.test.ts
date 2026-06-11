// SPDX-License-Identifier: Elastic-2.0
//
// Worker notify fan-out: emails/texts unread members, debounces repeats,
// and skips members who have already read the thread.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  type PgliteHarness,
} from '../../../api/src/__tests__/_pglite-harness';
import { appUsers, messages, threadMembers, threads } from '@vibe/db/schema';

import { runInternalMessageNotify } from '../jobs/internal-message-notify';

const silent = pino({ enabled: false });
let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

async function setup(): Promise<{
  firmId: string;
  sender: string;
  recipient: string;
  threadId: string;
  messageId: string;
  recipientMemberId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const [b] = await harness.db
    .insert(appUsers)
    .values({
      firmId: seed.firmId,
      email: 'bob@test.example',
      fullName: 'Bob',
      mobilePhone: '+15551234567',
    })
    .returning({ id: appUsers.id });
  const [t] = await harness.db
    .insert(threads)
    .values({
      firmId: seed.firmId,
      tDekWrapped: Buffer.alloc(48, 7),
      kind: 'internal',
      title: null,
    })
    .returning({ id: threads.id });
  await harness.db.insert(threadMembers).values({
    threadId: t!.id,
    appUserId: seed.appUserId,
    memberRole: 'staff',
    lastReadAt: new Date(),
  });
  const [rm] = await harness.db
    .insert(threadMembers)
    .values({ threadId: t!.id, appUserId: b!.id, memberRole: 'staff' })
    .returning({ id: threadMembers.id });
  const [m] = await harness.db
    .insert(messages)
    .values({
      threadId: t!.id,
      senderAppUserId: seed.appUserId,
      bodyCiphertext: Buffer.alloc(64, 9),
      excerptPlaintext: 'hi',
    })
    .returning({ id: messages.id });
  return {
    firmId: seed.firmId,
    sender: seed.appUserId,
    recipient: b!.id,
    threadId: t!.id,
    messageId: m!.id,
    recipientMemberId: rm!.id,
  };
}

describe('runInternalMessageNotify', () => {
  it('emails + texts an unread recipient, then debounces a repeat', async () => {
    const s = await setup();
    const emails: string[] = [];
    const sms: string[] = [];
    const deps = {
      sendEmail: async (a: { to: string }) => {
        emails.push(a.to);
      },
      sendSms: async (a: { to: string }) => {
        sms.push(a.to);
      },
      appBaseUrl: 'https://app.example',
    };
    const r1 = await runInternalMessageNotify(
      harness.db,
      silent,
      { threadId: s.threadId, messageId: s.messageId, firmId: s.firmId, senderAppUserId: s.sender },
      deps,
    );
    expect(r1.emailed).toBe(1);
    expect(r1.texted).toBe(1);
    expect(emails).toEqual(['bob@test.example']);

    // Immediate re-run → debounced (last_notified_at within window).
    const r2 = await runInternalMessageNotify(
      harness.db,
      silent,
      { threadId: s.threadId, messageId: s.messageId, firmId: s.firmId, senderAppUserId: s.sender },
      deps,
    );
    expect(r2.emailed).toBe(0);
  });

  it('skips a recipient who has already read the thread', async () => {
    const s = await setup();
    await harness.db
      .update(threadMembers)
      .set({ lastReadAt: new Date(Date.now() + 1000) })
      .where(eq(threadMembers.id, s.recipientMemberId));
    const emails: string[] = [];
    const r = await runInternalMessageNotify(
      harness.db,
      silent,
      { threadId: s.threadId, messageId: s.messageId, firmId: s.firmId, senderAppUserId: s.sender },
      {
        sendEmail: async (a: { to: string }) => {
          emails.push(a.to);
        },
      },
    );
    expect(r.emailed).toBe(0);
    expect(emails).toHaveLength(0);
  });
});
