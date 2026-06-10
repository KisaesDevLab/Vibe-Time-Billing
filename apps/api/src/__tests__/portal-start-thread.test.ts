// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client-initiated messaging: a portal client can start a thread with no
// engagement (POST /threads). The thread auto-routes to the client's
// partner-in-charge as a staff member, lists for the client, and the firm
// can later assign it to an engagement (POST /threads/:id/engagement).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { and, eq, isNull } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { engagementThreadLinks, threadMembers, threads } from '@vibe/db/schema';
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

function portalApp(): express.Express {
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
  });
});
