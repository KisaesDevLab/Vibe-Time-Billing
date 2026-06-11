// SPDX-License-Identifier: Elastic-2.0
//
// Client-initiated messaging: a portal client can start a thread with no
// engagement (POST /threads). The thread auto-routes to the client's
// partner-in-charge as a staff member, lists for the client, and the firm
// can later assign it to an engagement (POST /threads/:id/engagement).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { and, eq, isNull } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { engagementThreadLinks, staffNotifications, threadMembers, threads } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';
import type { PortalSession } from '@vibe/core/auth';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { createPortalMessagingRouter } from '../portal/messaging';
import { createEngagementMessagingRouter } from '../engagement-messaging/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let identityId: string;
let sealDir: string;

/** In-memory stand-in for the sliding-window limiter's Redis surface. */
function fakeRedis(): {
  zremrangebyscore: (k: string, a: number, b: number) => Promise<number>;
  zcard: (k: string) => Promise<number>;
  zadd: (k: string, score: number, member: string) => Promise<number>;
  expire: (k: string, s: number) => Promise<number>;
} {
  const zsets = new Map<string, Map<string, number>>();
  const get = (k: string): Map<string, number> => {
    if (!zsets.has(k)) zsets.set(k, new Map());
    return zsets.get(k)!;
  };
  return {
    async zremrangebyscore(k, a, b) {
      const z = get(k);
      let n = 0;
      for (const [m, s] of z) {
        if (s >= a && s <= b) {
          z.delete(m);
          n++;
        }
      }
      return n;
    },
    async zcard(k) {
      return get(k).size;
    },
    async zadd(k, score, member) {
      get(k).set(member, score);
      return 1;
    },
    async expire() {
      return 1;
    },
  };
}

function portalApp(redis?: ReturnType<typeof fakeRedis>): express.Express {
  const app = express();
  app.use(express.json());
  const session: PortalSession = {
    realm: 'portal',
    sid: 'sid-1',
    portalIdentityId: identityId,
    firmId: seed.firmId,
    activeClientId: seed.clientId,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    csrfToken: 'csrf',
    ip: null,
    userAgent: null,
  };
  const router = createPortalMessagingRouter({
    db: harness.db,
    requireAuth: (req, _res, next) => {
      (req as unknown as { portalSession: PortalSession }).portalSession = session;
      next();
    },
    // reason: the limiter only uses the four zset methods the fake provides.
    redis: redis as unknown as Redis | undefined,
  });
  app.use('/api/portal/messaging', router);
  return app;
}

function staffApp(): express.Express {
  const app = express();
  app.use(express.json());
  const router = createEngagementMessagingRouter({
    db: harness.db,
    fakeUserRoles: new Map<string, RoleSlug[]>([[seed.appUserId, ['admin']]]),
  });
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  app.use('/api/staff/engagement-messaging', router);
  return app;
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-pst-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const idRow = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'Client Tom', 'tom@client.example') RETURNING id`,
  );
  identityId = (idRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status)
        VALUES (${identityId}, ${seed.clientId}, 'ACTIVE')`,
  );
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('portal-initiated thread', () => {
  it('creates a client-direct thread with no engagement, routed to the partner-in-charge', async () => {
    const res = await request(portalApp())
      .post('/api/portal/messaging/threads')
      .send({ body: 'Hi, I have a question about my return.' });
    expect(res.status).toBe(201);
    const threadId = res.body.threadId as string;
    expect(threadId).toBeTruthy();

    // Thread is client-scoped, no engagement link.
    const [t] = await harness.db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
    expect(t!.clientId).toBe(seed.clientId);
    expect(t!.kind).toBe('client');
    const [link] = await harness.db
      .select()
      .from(engagementThreadLinks)
      .where(eq(engagementThreadLinks.threadId, threadId));
    expect(link).toBeUndefined();

    // Members: the initiating client + the partner-in-charge (seed.appUserId).
    const members = await harness.db
      .select()
      .from(threadMembers)
      .where(and(eq(threadMembers.threadId, threadId), isNull(threadMembers.removedAt)));
    expect(members.some((m) => m.portalIdentityId === identityId)).toBe(true);
    expect(members.some((m) => m.appUserId === seed.appUserId)).toBe(true);
  });

  it('lists the client-direct thread for the portal client', async () => {
    await request(portalApp()).post('/api/portal/messaging/threads').send({ body: 'first' });
    const list = await request(portalApp()).get('/api/portal/messaging/threads');
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0].engagementId).toBeNull();
  });

  it('round-trips the first message through encryption', async () => {
    const create = await request(portalApp())
      .post('/api/portal/messaging/threads')
      .send({ body: 'My EIN changed this year.' });
    const threadId = create.body.threadId as string;
    const msgs = await request(portalApp()).get(
      `/api/portal/messaging/threads/${threadId}/messages`,
    );
    expect(msgs.status).toBe(200);
    expect(msgs.body.items.map((m: { body: string }) => m.body)).toContain(
      'My EIN changed this year.',
    );
  });

  it('rejects an empty body', async () => {
    const res = await request(portalApp()).post('/api/portal/messaging/threads').send({ body: '' });
    expect(res.status).toBe(400);
  });

  it('the firm can assign the client-direct thread to an engagement', async () => {
    const create = await request(portalApp())
      .post('/api/portal/messaging/threads')
      .send({ body: 'please file my extension' });
    const threadId = create.body.threadId as string;

    const assign = await request(staffApp())
      .post(`/api/staff/engagement-messaging/threads/${threadId}/engagement`)
      .send({ engagementId: seed.engagementId });
    expect(assign.status).toBe(200);
    expect(assign.body.engagementId).toBe(seed.engagementId);

    const [link] = await harness.db
      .select()
      .from(engagementThreadLinks)
      .where(eq(engagementThreadLinks.threadId, threadId));
    expect(link!.engagementId).toBe(seed.engagementId);

    // GET /threads/:id now reflects the assignment.
    const detail = await request(staffApp()).get(
      `/api/staff/engagement-messaging/threads/${threadId}`,
    );
    expect(detail.body.thread.engagementId).toBe(seed.engagementId);

    // Re-assigning a now-linked thread → 409.
    const again = await request(staffApp())
      .post(`/api/staff/engagement-messaging/threads/${threadId}/engagement`)
      .send({ engagementId: seed.engagementId });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('thread_already_linked');

    // …and unlink restores the client-direct state.
    const unlink = await request(staffApp()).delete(
      `/api/staff/engagement-messaging/threads/${threadId}/engagement`,
    );
    expect(unlink.status).toBe(200);
    const links = await harness.db
      .select()
      .from(engagementThreadLinks)
      .where(eq(engagementThreadLinks.threadId, threadId));
    expect(links).toHaveLength(0);
    const unlinkAgain = await request(staffApp()).delete(
      `/api/staff/engagement-messaging/threads/${threadId}/engagement`,
    );
    expect(unlinkAgain.status).toBe(404);
    expect(unlinkAgain.body.error).toBe('not_linked');
  });

  it('notifies the routed staff and dates the thread title', async () => {
    const res = await request(portalApp())
      .post('/api/portal/messaging/threads')
      .send({ body: 'question about my W-2' });
    expect(res.status).toBe(201);
    const threadId = res.body.threadId as string;

    const [t] = await harness.db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
    // Title carries the contact name and an ISO date suffix.
    expect(t!.title).toMatch(/^Client Tom \(.*\) — \d{4}-\d{2}-\d{2}$/);

    const notifs = await harness.db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.entityId, threadId));
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    expect(notifs.some((n) => n.recipientAppUserId === seed.appUserId)).toBe(true);
    expect(notifs[0]!.type).toBe('client_message_thread');
    expect(notifs[0]!.body).toContain('question about my W-2');
  });

  it('rate-limits thread creation (5/hour per identity → 429)', async () => {
    const redis = fakeRedis();
    const app = portalApp(redis);
    for (let i = 0; i < 5; i++) {
      const ok = await request(app)
        .post('/api/portal/messaging/threads')
        .send({ body: `message ${i}` });
      expect(ok.status).toBe(201);
    }
    const blocked = await request(app)
      .post('/api/portal/messaging/threads')
      .send({ body: 'one too many' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
  });

  it('routes to engagement-assigned staff too', async () => {
    // A second staff user assigned to the client's engagement (but who has
    // never messaged) must be a member of the new thread.
    const u = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${seed.firmId}, 'assignee@test.example', 'Assigned Anna', 'Anna', 'A') RETURNING id`,
    );
    const assigneeId = (u as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO engagement_assignment (engagement_id, app_user_id, role)
          VALUES (${seed.engagementId}, ${assigneeId}, 'STAFF')`,
    );
    const res = await request(portalApp())
      .post('/api/portal/messaging/threads')
      .send({ body: 'hello team' });
    expect(res.status).toBe(201);
    const members = await harness.db
      .select()
      .from(threadMembers)
      .where(and(eq(threadMembers.threadId, res.body.threadId), isNull(threadMembers.removedAt)));
    expect(members.some((m) => m.appUserId === assigneeId)).toBe(true);
  });
});
