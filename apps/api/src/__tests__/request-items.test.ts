// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0084 — per-request items: GET list, PATCH single, POST fulfill +
// parent-status roll-up only when every REQUIRED item is FULFILLED.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { clientRequestItems, clientRequests } from '@vibe/db/schema';
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
interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}
async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
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

async function seedRequestWithItems(
  db: PgliteHarness['db'],
  firmId: string,
  engagementId: string,
  items: Array<{ label: string; required: boolean }>,
): Promise<{ requestId: string; itemIds: string[] }> {
  const reqRow = await db.execute(
    sql`INSERT INTO client_request (firm_id, engagement_id, title)
        VALUES (${firmId}, ${engagementId}, 'parent') RETURNING id`,
  );
  const requestId = (reqRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const itemIds: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const r = await db.execute(
      sql`INSERT INTO client_request_item (client_request_id, ordinal, label, required)
          VALUES (${requestId}, ${i}, ${it.label}, ${it.required}) RETURNING id`,
    );
    itemIds.push((r as unknown as { rows: { id: string }[] }).rows[0]!.id);
  }
  return { requestId, itemIds };
}

describe('request items (staff)', () => {
  it('GET /:id/items returns items in ordinal order', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const { requestId } = await seedRequestWithItems(harness.db, seed.firmId, seed.engagementId, [
      { label: 'first', required: true },
      { label: 'second', required: false },
      { label: 'third', required: true },
    ]);
    const r = await invoke(router, 'get', '/:id/items', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: requestId },
      }),
    });
    expect(r.statusCode).toBe(200);
    const items = (r.jsonBody as { items: Array<{ label: string; ordinal: number }> }).items;
    expect(items.map((i) => i.label)).toEqual(['first', 'second', 'third']);
  });

  it('PATCH /:id/items/:itemId updates label/body/dueDate', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const { requestId, itemIds } = await seedRequestWithItems(
      harness.db,
      seed.firmId,
      seed.engagementId,
      [{ label: 'old', required: true }],
    );
    const r = await invoke(router, 'patch', '/:id/items/:itemId', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: requestId, itemId: itemIds[0]! },
        body: { label: 'new', dueDate: '2026-12-31' },
      }),
    });
    expect(r.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(clientRequestItems)
      .where(eq(clientRequestItems.id, itemIds[0]!));
    expect(row!.label).toBe('new');
    expect(String(row!.dueDate)).toBe('2026-12-31');
  });

  it('fulfilling the last required item rolls parent to FULFILLED', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const { requestId, itemIds } = await seedRequestWithItems(
      harness.db,
      seed.firmId,
      seed.engagementId,
      [
        { label: 'A', required: true },
        { label: 'B', required: true },
      ],
    );

    // Fulfill the first required item; parent stays OPEN.
    const r1 = await invoke(router, 'post', '/:id/items/:itemId/fulfill', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: requestId, itemId: itemIds[0]! },
        body: { text: 'got A' },
      }),
    });
    expect(r1.statusCode).toBe(200);
    let [parent] = await harness.db
      .select()
      .from(clientRequests)
      .where(eq(clientRequests.id, requestId));
    expect(parent!.status).toBe('OPEN');

    // Fulfill the second; now the parent should flip to FULFILLED.
    const r2 = await invoke(router, 'post', '/:id/items/:itemId/fulfill', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: requestId, itemId: itemIds[1]! },
      }),
    });
    expect(r2.statusCode).toBe(200);
    [parent] = await harness.db
      .select()
      .from(clientRequests)
      .where(eq(clientRequests.id, requestId));
    expect(parent!.status).toBe('FULFILLED');
    expect(parent!.fulfilledAt).not.toBeNull();
  });

  it('non-required items being unfulfilled do not block parent fulfillment', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const { requestId, itemIds } = await seedRequestWithItems(
      harness.db,
      seed.firmId,
      seed.engagementId,
      [
        { label: 'must', required: true },
        { label: 'nice-to-have', required: false },
      ],
    );
    // Only fulfill the required one.
    const r = await invoke(router, 'post', '/:id/items/:itemId/fulfill', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: requestId, itemId: itemIds[0]! },
      }),
    });
    expect(r.statusCode).toBe(200);
    const [parent] = await harness.db
      .select()
      .from(clientRequests)
      .where(eq(clientRequests.id, requestId));
    expect(parent!.status).toBe('FULFILLED');
  });

  it('cross-firm request: GET items → 404, PATCH item → 404, fulfill → 404', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const { requestId, itemIds } = await seedRequestWithItems(
      harness.db,
      seed.firmId,
      seed.engagementId,
      [{ label: 'i', required: true }],
    );
    // Another firm staff.
    const otherFirm = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other') RETURNING id`,
    );
    const otherFirmId = (otherFirm as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@x', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherRouter = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[otherUserId, ['partner']]]),
    });
    const get = await invoke(otherRouter, 'get', '/:id/items', {
      ...makeReq({
        firmId: otherFirmId,
        appUserId: otherUserId,
        params: { id: requestId },
      }),
    });
    expect(get.statusCode).toBe(404);
    const patch = await invoke(otherRouter, 'patch', '/:id/items/:itemId', {
      ...makeReq({
        firmId: otherFirmId,
        appUserId: otherUserId,
        params: { id: requestId, itemId: itemIds[0]! },
        body: { label: 'hi' },
      }),
    });
    expect(patch.statusCode).toBe(404);
    const fulfill = await invoke(otherRouter, 'post', '/:id/items/:itemId/fulfill', {
      ...makeReq({
        firmId: otherFirmId,
        appUserId: otherUserId,
        params: { id: requestId, itemId: itemIds[0]! },
      }),
    });
    expect(fulfill.statusCode).toBe(404);
  });
});
