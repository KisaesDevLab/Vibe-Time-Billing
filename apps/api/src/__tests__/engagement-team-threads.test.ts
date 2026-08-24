// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0225 — engagement-scoped team (internal) threads: lazy create-or-join,
// member seeding from assignments + partner-in-charge, and the
// interaction rule (threads stay out of the Team and Clients lists until
// a conversation actually exists).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { and, eq, isNull } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appUsers, engagementAssignments, threadMembers, threads } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { createInternalMessagingRouter } from '../internal-messaging/routes';
import { createEngagementMessagingRouter } from '../engagement-messaging/routes';
import { provisionThreadForEngagement } from '../engagement-messaging/lifecycle';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let userB: string;
let userC: string;
let sealDir: string;

function buildApp(actingUserId: string): express.Express {
  const app = express();
  app.use(express.json());
  const roles = new Map<string, RoleSlug[]>([
    [seed.appUserId, ['staff']],
    [userB, ['staff']],
    [userC, ['staff']],
  ]);
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: actingUserId,
    };
    next();
  });
  app.use(
    '/api/staff/internal-messaging',
    createInternalMessagingRouter({
      db: harness.db,
      fakeUserRoles: roles,
      enqueueNotify: async () => undefined,
    }),
  );
  app.use(
    '/api/staff/engagement-messaging',
    createEngagementMessagingRouter({ db: harness.db, fakeUserRoles: roles }),
  );
  return app;
}

async function addUser(email: string, name: string): Promise<string> {
  const [first, last] = name.split(' ');
  const [u] = await harness.db
    .insert(appUsers)
    .values({ firmId: seed.firmId, email, fullName: name, firstName: first, lastName: last })
    .returning({ id: appUsers.id });
  return u!.id;
}

async function activeMemberIds(threadId: string): Promise<Set<string | null>> {
  const rows = await harness.db
    .select({ appUserId: threadMembers.appUserId })
    .from(threadMembers)
    .where(and(eq(threadMembers.threadId, threadId), isNull(threadMembers.removedAt)));
  return new Set(rows.map((r) => r.appUserId));
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-ett-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  userB = await addUser('bob@test.example', 'Bob Builder');
  userC = await addUser('carol@test.example', 'Carol Carer');
  // Bob is assigned to the engagement; Sarah (seed user) is the client's
  // partner-in-charge; Carol is neither.
  await harness.db
    .insert(engagementAssignments)
    .values({ engagementId: seed.engagementId, appUserId: userB });
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('engagement team thread — create-or-join', () => {
  it('resolves 404 until someone starts the discussion', async () => {
    const res = await request(buildApp(seed.appUserId)).get(
      `/api/staff/internal-messaging/engagements/${seed.engagementId}/thread`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_team_thread');
  });

  it('creates an internal thread seeded from assignments + partner, idempotently', async () => {
    const app = buildApp(seed.appUserId);
    const created = await request(app)
      .post(`/api/staff/internal-messaging/engagements/${seed.engagementId}/thread`)
      .send({});
    expect(created.status).toBe(201);
    const threadId = created.body.threadId as string;

    const [t] = await harness.db
      .select({ kind: threads.kind, title: threads.title, clientId: threads.clientId })
      .from(threads)
      .where(eq(threads.id, threadId));
    expect(t!.kind).toBe('internal');
    expect(t!.title).toBe('Test Engagement');
    // Internal threads carry no client pointer — the portal can never
    // resolve them.
    expect(t!.clientId).toBeNull();

    const members = await activeMemberIds(threadId);
    expect(members.has(userB)).toBe(true); // assigned staff
    expect(members.has(seed.appUserId)).toBe(true); // partner-in-charge (also creator)
    expect(members.has(userC)).toBe(false);

    // Second POST returns the same thread.
    const again = await request(app)
      .post(`/api/staff/internal-messaging/engagements/${seed.engagementId}/thread`)
      .send({});
    expect(again.status).toBe(200);
    expect(again.body.threadId).toBe(threadId);
  });

  it('lets a non-member staffer see member:false and join via POST', async () => {
    await request(buildApp(seed.appUserId))
      .post(`/api/staff/internal-messaging/engagements/${seed.engagementId}/thread`)
      .send({});
    const carol = buildApp(userC);
    const resolved = await request(carol).get(
      `/api/staff/internal-messaging/engagements/${seed.engagementId}/thread`,
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.member).toBe(false);

    const joined = await request(carol)
      .post(`/api/staff/internal-messaging/engagements/${seed.engagementId}/thread`)
      .send({});
    expect(joined.status).toBe(200);
    const members = await activeMemberIds(joined.body.threadId as string);
    expect(members.has(userC)).toBe(true);
  });
});

describe('interaction rule — Team list', () => {
  it('hides the engagement thread until a message exists, then labels it', async () => {
    const app = buildApp(seed.appUserId);
    const created = await request(app)
      .post(`/api/staff/internal-messaging/engagements/${seed.engagementId}/thread`)
      .send({});
    const threadId = created.body.threadId as string;

    // No messages yet — the thread stays out of the Team list.
    let list = await request(app).get('/api/staff/internal-messaging/threads');
    expect(list.status).toBe(200);
    expect(list.body.threads.some((t: { threadId: string }) => t.threadId === threadId)).toBe(
      false,
    );

    await request(app)
      .post(`/api/staff/internal-messaging/threads/${threadId}/messages`)
      .send({ body: 'Kicking off the return.' });

    list = await request(app).get('/api/staff/internal-messaging/threads');
    const row = list.body.threads.find((t: { threadId: string }) => t.threadId === threadId);
    expect(row).toBeTruthy();
    expect(row.label).toBe('Test Engagement');
    expect(row.engagementId).toBe(seed.engagementId);
    expect(row.clientName).toBe('Test Client Co');

    // Ordinary DMs are unaffected by the rule (they list even before the
    // first message — existing behavior).
    const dm = await request(app)
      .post('/api/staff/internal-messaging/threads')
      .send({ memberIds: [userB] });
    list = await request(app).get('/api/staff/internal-messaging/threads');
    expect(
      list.body.threads.some((t: { threadId: string }) => t.threadId === dm.body.threadId),
    ).toBe(true);
  });
});

describe('interaction rule — Clients list', () => {
  it('hides an auto-provisioned engagement thread until someone posts', async () => {
    const app = buildApp(seed.appUserId);
    const threadId = await provisionThreadForEngagement(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'Test Engagement',
      creatorAppUserId: seed.appUserId,
    });
    expect(threadId).toBeTruthy();

    let list = await request(app).get('/api/staff/engagement-messaging/threads');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(0);

    await request(app)
      .post(`/api/staff/engagement-messaging/threads/${threadId}/messages`)
      .send({ body: 'Hello — your documents are ready.' });

    list = await request(app).get('/api/staff/engagement-messaging/threads');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].threadId).toBe(threadId);
  });
});
