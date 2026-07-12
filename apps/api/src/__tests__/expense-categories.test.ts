// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0210 — managed expense-category picklist: list / add (revives archived
// via upsert) / archive. Expense rows keep storing the category NAME.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';

import { expenseCategories } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createExpensesRouter } from '../expenses/routes';

let h: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  h = await buildPgliteHarness();
  seed = await seedMinimalFirm(h.db);
});
afterEach(async () => {
  await h.close();
});

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  send(b?: unknown): FakeRes;
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
    send() {
      return this;
    },
  };
}
async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'delete',
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const chain = route.stack;
  for (let i = 0; i < chain.length - 1; i++) {
    let advanced = false;
    await (chain[i]!.handle as (rq: unknown, rs: unknown, nx: () => void) => unknown)(
      req,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(req, res);
  return res;
}
function req(body: unknown = {}, params: Record<string, string> = {}): Record<string, unknown> {
  return {
    body,
    params,
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}
function router() {
  // Category management is taxonomy:write (admin), like work codes.
  return createExpensesRouter({
    db: h.db,
    fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
  });
}

describe('expense categories', () => {
  it('lists, adds, archives, and revives on re-add', async () => {
    await h.db.insert(expenseCategories).values({ firmId: seed.firmId, name: 'Filing fees' });

    let r = await invoke(router(), 'get', '/categories', req());
    let items = (r.jsonBody as { items: { id: string; name: string }[] }).items;
    expect(items.map((i) => i.name)).toEqual(['Filing fees']);

    // Add.
    r = await invoke(router(), 'post', '/categories', req({ name: 'Courier' }));
    expect(r.statusCode).toBe(201);
    r = await invoke(router(), 'get', '/categories', req());
    items = (r.jsonBody as { items: { id: string; name: string }[] }).items;
    expect(items.map((i) => i.name)).toEqual(['Courier', 'Filing fees']);

    // Archive drops it from the list.
    const courier = items.find((i) => i.name === 'Courier')!;
    r = await invoke(
      router(),
      'delete',
      '/categories/:categoryId',
      req({}, { categoryId: courier.id }),
    );
    expect(r.statusCode).toBe(204);
    r = await invoke(router(), 'get', '/categories', req());
    items = (r.jsonBody as { items: { id: string; name: string }[] }).items;
    expect(items.map((i) => i.name)).toEqual(['Filing fees']);

    // Re-adding the same name — even differently cased — revives the
    // archived row instead of minting a near-duplicate.
    r = await invoke(router(), 'post', '/categories', req({ name: 'courier' }));
    expect(r.statusCode).toBe(201);
    expect((r.jsonBody as { item: { id: string } }).item.id).toBe(courier.id);
    r = await invoke(router(), 'get', '/categories', req());
    items = (r.jsonBody as { items: { id: string; name: string }[] }).items;
    expect(items.map((i) => i.name)).toEqual(['Courier', 'Filing fees']);

    // No-op re-add of an active category: 200, same row, list unchanged.
    r = await invoke(router(), 'post', '/categories', req({ name: 'COURIER' }));
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { item: { id: string } }).item.id).toBe(courier.id);
  });

  it('refuses category management without taxonomy:write', async () => {
    const staffRouter = createExpensesRouter({
      db: h.db,
      fakeUserRoles: new Map([[seed.appUserId, ['staff']]]),
    });
    const r = await invoke(staffRouter, 'post', '/categories', req({ name: 'Junk' }));
    expect(r.statusCode).toBe(403);
    // Reading the picklist stays open to anyone who logs expenses.
    const list = await invoke(staffRouter, 'get', '/categories', req());
    expect(list.statusCode).toBe(200);
  });

  it('rejects an empty name and archives nothing cross-firm', async () => {
    const r = await invoke(router(), 'post', '/categories', req({ name: '   ' }));
    expect(r.statusCode).toBe(400);
    const miss = await invoke(
      router(),
      'delete',
      '/categories/:categoryId',
      req({}, { categoryId: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(miss.statusCode).toBe(404);
  });
});
