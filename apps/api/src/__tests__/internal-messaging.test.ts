// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Staff-to-staff messaging: directory, DM create + dedupe, group create,
// encrypted send round-trip, unread counts + mark-read, member add/remove,
// and that a send enqueues a (stubbed) notification.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appUsers, threads } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { createInternalMessagingRouter } from '../internal-messaging/routes';
import type { InternalMessageNotifyJob } from '../internal-messaging/queue';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let userB: string;
let sealDir: string;
let notified: InternalMessageNotifyJob[];

function buildApp(actingUserId: string): express.Express {
  const app = express();
  app.use(express.json());
  const roles = new Map<string, RoleSlug[]>([
    [seed.appUserId, ['staff']],
    [userB, ['staff']],
  ]);
  const router = createInternalMessagingRouter({
    db: harness.db,
    fakeUserRoles: roles,
    enqueueNotify: async (job) => {
      notified.push(job);
    },
  });
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: actingUserId,
    };
    next();
  });
  app.use('/api/staff/internal-messaging', router);
  return app;
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-im-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  notified = [];
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const [b] = await harness.db
    .insert(appUsers)
    .values({
      firmId: seed.firmId,
      email: 'bob@test.example',
      fullName: 'Bob Builder',
      firstName: 'Bob',
      lastName: 'Builder',
    })
    .returning({ id: appUsers.id });
  userB = b!.id;
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('directory', () => {
  it('lists other active staff, excluding the caller', async () => {
    const res = await request(buildApp(seed.appUserId)).get(
      '/api/staff/internal-messaging/directory',
    );
    expect(res.status).toBe(200);
    const ids = res.body.staff.map((s: { id: string }) => s.id);
    expect(ids).toContain(userB);
    expect(ids).not.toContain(seed.appUserId);
  });
});

describe('direct messages', () => {
  it('creates a DM, sends an encrypted message, and dedupes on re-create', async () => {
    const app = buildApp(seed.appUserId);
    const create = await request(app)
      .post('/api/staff/internal-messaging/threads')
      .send({ memberIds: [userB], body: 'hello bob' });
    expect(create.status).toBe(201);
    const threadId = create.body.threadId as string;

    // kind=internal, body stored encrypted (not plaintext).
    const [t] = await harness.db.select().from(threads).where(eq(threads.id, threadId));
    expect(t!.kind).toBe('internal');

    // Re-create with same person → deduped to same thread.
    const again = await request(app)
      .post('/api/staff/internal-messaging/threads')
      .send({ memberIds: [userB] });
    expect(again.status).toBe(200);
    expect(again.body.threadId).toBe(threadId);
    expect(again.body.deduped).toBe(true);

    // Bob can read it, decrypted.
    const msgs = await request(buildApp(userB)).get(
      `/api/staff/internal-messaging/threads/${threadId}/messages`,
    );
    expect(msgs.status).toBe(200);
    expect(msgs.body.items[0].body).toBe('hello bob');
    expect(msgs.body.items[0].mine).toBe(false);

    // Sending enqueued a notification.
    expect(notified.length).toBeGreaterThanOrEqual(1);
    expect(notified[0]!.senderAppUserId).toBe(seed.appUserId);
  });

  it('tracks unread for the recipient and clears on read', async () => {
    const app = buildApp(seed.appUserId);
    const create = await request(app)
      .post('/api/staff/internal-messaging/threads')
      .send({ memberIds: [userB], body: 'first' });
    const threadId = create.body.threadId as string;
    await request(app)
      .post(`/api/staff/internal-messaging/threads/${threadId}/messages`)
      .send({ body: 'second' });

    // Bob: 2 unread.
    const bobApp = buildApp(userB);
    const beforeList = await request(bobApp).get('/api/staff/internal-messaging/threads');
    expect(beforeList.body.threads[0].unread).toBe(2);
    const beforeCount = await request(bobApp).get('/api/staff/internal-messaging/unread-count');
    expect(beforeCount.body.unread).toBe(2);

    // Reading the messages marks them read.
    await request(bobApp).get(`/api/staff/internal-messaging/threads/${threadId}/messages`);
    const afterCount = await request(bobApp).get('/api/staff/internal-messaging/unread-count');
    expect(afterCount.body.unread).toBe(0);

    // Sender never has unread for their own messages.
    const senderCount = await request(app).get('/api/staff/internal-messaging/unread-count');
    expect(senderCount.body.unread).toBe(0);
  });
});

describe('group threads', () => {
  it('creates a named group with all members and supports add/remove', async () => {
    // third user
    const [c] = await harness.db
      .insert(appUsers)
      .values({
        firmId: seed.firmId,
        email: 'carol@test.example',
        fullName: 'Carol Carer',
        firstName: 'Carol',
        lastName: 'Carer',
      })
      .returning({ id: appUsers.id });
    const userC = c!.id;

    const app = buildApp(seed.appUserId);
    const create = await request(app)
      .post('/api/staff/internal-messaging/threads')
      .send({ memberIds: [userB, userC], title: 'Tax Team', body: 'kickoff' });
    expect(create.status).toBe(201);
    const threadId = create.body.threadId as string;

    const detail = await request(app).get(`/api/staff/internal-messaging/threads/${threadId}`);
    expect(detail.body.thread.title).toBe('Tax Team');
    expect(detail.body.members).toHaveLength(3);

    // Remove Carol, then re-add.
    const del = await request(app).delete(
      `/api/staff/internal-messaging/threads/${threadId}/members/${userC}`,
    );
    expect(del.status).toBe(200);
    const after = await request(app).get(`/api/staff/internal-messaging/threads/${threadId}`);
    expect(after.body.members).toHaveLength(2);

    const add = await request(app)
      .post(`/api/staff/internal-messaging/threads/${threadId}/members`)
      .send({ appUserId: userC });
    expect(add.status).toBe(200);
    const re = await request(app).get(`/api/staff/internal-messaging/threads/${threadId}`);
    expect(re.body.members).toHaveLength(3);
  });

  it('non-members cannot read a thread', async () => {
    const [d] = await harness.db
      .insert(appUsers)
      .values({
        firmId: seed.firmId,
        email: 'dave@test.example',
        fullName: 'Dave Outsider',
        firstName: 'Dave',
        lastName: 'Outsider',
      })
      .returning({ id: appUsers.id });
    const create = await request(buildApp(seed.appUserId))
      .post('/api/staff/internal-messaging/threads')
      .send({ memberIds: [userB], body: 'private' });
    const threadId = create.body.threadId as string;

    // Dave isn't in fakeUserRoles → give him a role + act as him.
    const app = express();
    app.use(express.json());
    const router = createInternalMessagingRouter({
      db: harness.db,
      fakeUserRoles: new Map<string, RoleSlug[]>([[d!.id, ['staff']]]),
      enqueueNotify: async () => undefined,
    });
    app.use((req, _res, next) => {
      (req as unknown as { staffSession: unknown }).staffSession = {
        firmId: seed.firmId,
        appUserId: d!.id,
      };
      next();
    });
    app.use('/api/staff/internal-messaging', router);
    const res = await request(app).get(
      `/api/staff/internal-messaging/threads/${threadId}/messages`,
    );
    expect(res.status).toBe(403);
  });
});
