// SPDX-License-Identifier: Elastic-2.0
//
// Message view display fields — the staff thread list must surface the
// CLIENT name (not just the engagement/title) and who last replied (the
// person), so a firm user can tell at a glance that the client responded.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import type { RoleSlug } from '@vibe/core/rbac';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { threads, threadMembers, messages } from '@vibe/db/schema';
import { createEngagementMessagingRouter } from '../engagement-messaging/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  a.use(
    '/api/staff/engagement-messaging',
    createEngagementMessagingRouter({
      db: harness.db,
      fakeUserRoles: new Map<string, RoleSlug[]>([[seed.appUserId, ['staff']]]),
    }),
  );
  return a;
}

async function seedClientThread(title: string): Promise<string> {
  const [t] = await harness.db
    .insert(threads)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      tDekWrapped: Buffer.alloc(60, 1),
      title,
      kind: 'client',
    })
    .returning({ id: threads.id });
  await harness.db.insert(threadMembers).values({
    threadId: t!.id,
    appUserId: seed.appUserId,
    memberRole: 'staff',
  });
  return t!.id;
}

describe('engagement message thread list — display fields', () => {
  it('returns the client name alongside the engagement title', async () => {
    await seedClientThread('Annual Tax 2026');
    const res = await request(app()).get('/api/staff/engagement-messaging/threads');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const t = res.body.items[0];
    // seedMinimalFirm creates client "Test Client Co".
    expect(t.clientName).toBe('Test Client Co');
    expect(t.title).toBe('Annual Tax 2026');
  });

  it('surfaces who last replied (the person + kind)', async () => {
    const threadId = await seedClientThread('Bookkeeping');
    await harness.db.insert(messages).values({
      threadId,
      senderAppUserId: seed.appUserId, // "Sarah Chen"
      bodyCiphertext: Buffer.alloc(48, 1),
    });
    const res = await request(app()).get('/api/staff/engagement-messaging/threads');
    const t = res.body.items.find((r: { threadId: string }) => r.threadId === threadId);
    expect(t.lastReplyBy).toBe('Sarah Chen');
    expect(t.lastReplyKind).toBe('staff');
    expect(t.lastReplyAt).toBeTruthy();
  });

  it('exposes the client name on the thread detail too', async () => {
    const threadId = await seedClientThread('Payroll');
    const res = await request(app()).get(`/api/staff/engagement-messaging/threads/${threadId}`);
    expect(res.status).toBe(200);
    expect(res.body.thread.clientName).toBe('Test Client Co');
  });
});
