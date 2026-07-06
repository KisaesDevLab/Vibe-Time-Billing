// SPDX-License-Identifier: Elastic-2.0
//
// A new DROP_OFF request with no explicit assignee defaults to the
// engagement's first-listed assignee (earliest assignedAt).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type express from 'express';

import { clientRequests } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createRequestRouter } from '../requests/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

function makeRes() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.jsonBody = b;
      return this;
    },
  };
}
async function createRequest(body: unknown): Promise<ReturnType<typeof makeRes>> {
  const router: express.Router = createRequestRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  const layer = (router as unknown as { stack: Array<{ route?: unknown }> }).stack.find((l) => {
    const r = l.route as { path: string; methods: Record<string, boolean> } | undefined;
    return r?.path === '/' && r.methods['post'] === true;
  });
  if (!layer) throw new Error('route not registered');
  const route = (layer as { route: { stack: Array<{ handle: (...a: unknown[]) => unknown }> } })
    .route;
  const handler = route.stack[route.stack.length - 1]!.handle;
  const res = makeRes();
  const req = {
    body,
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
}

async function addAssignee(appUserId: string, assignedAt: string): Promise<void> {
  await harness.db.execute(
    sql`INSERT INTO engagement_assignment (engagement_id, app_user_id, role, assigned_at)
        VALUES (${seed.engagementId}, ${appUserId}, 'STAFF', ${assignedAt})`,
  );
}

describe('drop-off default assignee', () => {
  it('defaults to the engagement first-listed (earliest) assignee', async () => {
    // Second staff user, assigned LATER than the seed user.
    const u2 = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${seed.firmId}, 'later@test.example', 'Later Staff', 'Later', 'Staff') RETURNING id`,
    );
    const laterId = (u2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await addAssignee(seed.appUserId, '2026-01-01T00:00:00Z'); // earliest
    await addAssignee(laterId, '2026-02-01T00:00:00Z');

    const res = await createRequest({
      engagementId: seed.engagementId,
      kind: 'DROP_OFF',
      title: 'Docs',
      dueDate: '2026-07-29',
      reminderDaysBefore: 3,
    });
    expect(res.statusCode).toBe(201);
    const rows = await harness.db
      .select({ assignee: clientRequests.assignedAppUserId })
      .from(clientRequests)
      .where(eq(clientRequests.engagementId, seed.engagementId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assignee).toBe(seed.appUserId); // earliest assignee
  });

  it('respects an explicit assignee over the default', async () => {
    await addAssignee(seed.appUserId, '2026-01-01T00:00:00Z');
    const other = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${seed.firmId}, 'x@test.example', 'X', 'X', 'X') RETURNING id`,
    );
    const otherId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const res = await createRequest({
      engagementId: seed.engagementId,
      kind: 'DROP_OFF',
      title: 'Docs',
      dueDate: '2026-07-29',
      reminderDaysBefore: 3,
      assignedAppUserId: otherId,
    });
    expect(res.statusCode).toBe(201);
    const [row] = await harness.db
      .select({ assignee: clientRequests.assignedAppUserId })
      .from(clientRequests)
      .where(eq(clientRequests.engagementId, seed.engagementId));
    expect(row!.assignee).toBe(otherId);
  });

  it('leaves assignee null when the engagement has no assignees', async () => {
    const res = await createRequest({
      engagementId: seed.engagementId,
      kind: 'DROP_OFF',
      title: 'Docs',
      dueDate: '2026-07-29',
      reminderDaysBefore: 3,
    });
    expect(res.statusCode).toBe(201);
    const [row] = await harness.db
      .select({ assignee: clientRequests.assignedAppUserId })
      .from(clientRequests)
      .where(eq(clientRequests.engagementId, seed.engagementId));
    expect(row!.assignee).toBeNull();
  });
});
