// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// PATCH /requests/:id can change status. Setting PENDING schedules an
// activation (due date minus reminder lead); moving off PENDING clears the
// schedule and stamps activation.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createRequestRouter } from '../requests/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

interface FakeReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  header(name: string): string | undefined;
  get(name: string): string | undefined;
}
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
async function invoke(
  router: express.Router,
  method: 'patch',
  path: string,
  req: FakeReq,
): Promise<ReturnType<typeof makeRes>> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}
function makeReq(over: Partial<FakeReq> & { firmId: string; appUserId: string }): FakeReq {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: over.firmId, appUserId: over.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
    ...over,
  };
}
async function seedReq(db: PgliteHarness['db'], firmId: string, engagementId: string) {
  const row = await db.execute(
    sql`INSERT INTO client_request (firm_id, engagement_id, title, status, priority, due_date, reminder_days_before)
        VALUES (${firmId}, ${engagementId}, 'Docs', 'OPEN', 'MEDIUM', '2026-07-29', 3) RETURNING id`,
  );
  return (row as unknown as { rows: { id: string }[] }).rows[0]!.id;
}
async function readReq(db: PgliteHarness['db'], id: string) {
  const r = await db.execute(
    sql`SELECT status, activation_date, activated_at FROM client_request WHERE id = ${id}`,
  );
  return (
    r as unknown as {
      rows: { status: string; activation_date: string | null; activated_at: string | null }[];
    }
  ).rows[0]!;
}

describe('request status edit', () => {
  it('setting PENDING schedules activation (due date minus reminder lead)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const id = await seedReq(harness.db, seed.firmId, seed.engagementId);
    const res = await invoke(router, 'patch', '/:id', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
      params: { id },
      body: { status: 'PENDING' },
    });
    expect(res.statusCode).toBe(200);
    const row = await readReq(harness.db, id);
    expect(row.status).toBe('PENDING');
    // due 2026-07-29 minus 3 days reminder = 2026-07-26.
    expect(String(row.activation_date)).toBe('2026-07-26');
  });

  it('moving off PENDING clears the schedule and stamps activation', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const id = await seedReq(harness.db, seed.firmId, seed.engagementId);
    await invoke(router, 'patch', '/:id', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
      params: { id },
      body: { status: 'PENDING' },
    });
    const res = await invoke(router, 'patch', '/:id', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
      params: { id },
      body: { status: 'OPEN' },
    });
    expect(res.statusCode).toBe(200);
    const row = await readReq(harness.db, id);
    expect(row.status).toBe('OPEN');
    expect(row.activation_date).toBeNull();
    expect(row.activated_at).not.toBeNull();
  });
});
