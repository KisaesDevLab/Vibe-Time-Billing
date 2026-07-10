// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Dashboard "Needs attention" counts — GET /api/staff/stats/inbox-counts.
// Seeds one unread internal message + one received intake session and
// asserts the aggregate shape + those counts (other surfaces are 0 here).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { appUsers, intakeSessions, messages, threadMembers, threads } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createStatsRouter } from '../stats/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  app.use(
    '/api/staff/stats',
    createStatsRouter({
      db: harness.db,
      fakeUserRoles: new Map<string, RoleSlug[]>([[seed.appUserId, ['staff']]]),
    }),
  );
  return app;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('GET /stats/inbox-counts', () => {
  it('returns all counts, zero when nothing is pending', async () => {
    const res = await request(buildApp()).get('/api/staff/stats/inbox-counts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      clientMsg: 0,
      teamMsg: 0,
      requests: 0,
      intake: 0,
      approvals: 0,
      notifications: 0, // BK-7 — in-app staff notifications
      bookingRequests: 0,
    });
  });

  it('counts unread team messages + received intake', async () => {
    // A teammate sends an internal message I haven't read.
    const [bob] = await harness.db
      .insert(appUsers)
      .values({ firmId: seed.firmId, email: 'bob@t.example', fullName: 'Bob' })
      .returning({ id: appUsers.id });
    const [t] = await harness.db
      .insert(threads)
      .values({ firmId: seed.firmId, tDekWrapped: Buffer.alloc(48, 1), kind: 'internal' })
      .returning({ id: threads.id });
    await harness.db.insert(threadMembers).values([
      { threadId: t!.id, appUserId: seed.appUserId, memberRole: 'staff' },
      { threadId: t!.id, appUserId: bob!.id, memberRole: 'staff' },
    ]);
    await harness.db.insert(messages).values({
      threadId: t!.id,
      senderAppUserId: bob!.id,
      bodyCiphertext: Buffer.alloc(64, 2),
      excerptPlaintext: 'hi',
    });

    // A received intake session.
    await harness.db.insert(intakeSessions).values({
      firmId: seed.firmId,
      targetStaffId: seed.appUserId,
      wrappedDek: Buffer.alloc(48, 3),
      status: 'received',
    });

    const res = await request(buildApp()).get('/api/staff/stats/inbox-counts');
    expect(res.status).toBe(200);
    expect(res.body.teamMsg).toBe(1);
    expect(res.body.intake).toBe(1);
    expect(res.body.clientMsg).toBe(0);
  });
});
