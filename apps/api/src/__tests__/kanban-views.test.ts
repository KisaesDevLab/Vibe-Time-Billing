// SPDX-License-Identifier: Elastic-2.0
//
// Saved kanban column-view router (0122). Per-user named views: create,
// list-own-only, patch (rename + columns), delete, owner scoping, and the
// unique (owner, board, name) guard.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type express from 'express';

import { appUsers, savedKanbanViews } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createKanbanViewRouter } from '../kanban-views/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let otherUserId: string;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const [u] = await harness.db
    .insert(appUsers)
    .values({
      firmId: seed.firmId,
      email: 'bob@test.example',
      fullName: 'Bob Lee',
      firstName: 'Bob',
      lastName: 'Lee',
    })
    .returning({ id: appUsers.id });
  otherUserId = u!.id;
});
afterEach(async () => {
  await harness.close();
});

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
  reqObj: Record<string, unknown>,
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
      reqObj,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(reqObj, res);
  return res;
}

function req(opts: {
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
  appUserId?: string;
}): Record<string, unknown> {
  return {
    body: opts.body ?? {},
    params: opts.params ?? {},
    query: opts.query ?? {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: opts.appUserId ?? seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

function router(roles: RoleSlug[] = ['admin']) {
  return createKanbanViewRouter({
    db: harness.db,
    fakeUserRoles: new Map([
      [seed.appUserId, roles],
      [otherUserId, roles],
    ]),
  });
}

async function create(name: string, cols: string[], appUserId?: string): Promise<FakeRes> {
  return invoke(router(), 'post', '/', req({ body: { name, visibleColumns: cols }, appUserId }));
}

describe('saved kanban views', () => {
  it('creates a view and returns it with its columns', async () => {
    const res = await create('My pipeline', ['IN_PROGRESS', 'REVIEW']);
    expect(res.statusCode).toBe(201);
    const view = (res.jsonBody as { view: { id: string; visibleColumns: string[] } }).view;
    expect(view.visibleColumns).toEqual(['IN_PROGRESS', 'REVIEW']);
    const [row] = await harness.db
      .select()
      .from(savedKanbanViews)
      .where(eq(savedKanbanViews.id, view.id));
    expect(row!.ownerId).toBe(seed.appUserId);
    expect(row!.boardType).toBe('engagement');
  });

  it('lists only the caller’s own views', async () => {
    await create('Mine', ['A']);
    await create('Bobs', ['B'], otherUserId);

    const mine = await invoke(router(), 'get', '/', req({}));
    expect((mine.jsonBody as { items: { name: string }[] }).items.map((v) => v.name)).toEqual([
      'Mine',
    ]);

    const bobs = await invoke(router(), 'get', '/', req({ appUserId: otherUserId }));
    expect((bobs.jsonBody as { items: { name: string }[] }).items.map((v) => v.name)).toEqual([
      'Bobs',
    ]);
  });

  it('rejects a duplicate name for the same user (409)', async () => {
    expect((await create('Dupe', ['A'])).statusCode).toBe(201);
    expect((await create('Dupe', ['B'])).statusCode).toBe(409);
  });

  it('patches name + columns (owner)', async () => {
    const id = ((await create('Old', ['A'])).jsonBody as { view: { id: string } }).view.id;
    const res = await invoke(
      router(),
      'patch',
      '/:id',
      req({ params: { id }, body: { name: 'New', visibleColumns: ['A', 'B', 'C'] } }),
    );
    expect(res.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(savedKanbanViews)
      .where(eq(savedKanbanViews.id, id));
    expect(row!.name).toBe('New');
    expect(row!.visibleColumns).toEqual(['A', 'B', 'C']);
  });

  it('cannot patch or delete another user’s view (404)', async () => {
    const id = ((await create('Bobs', ['A'], otherUserId)).jsonBody as { view: { id: string } })
      .view.id;
    const patch = await invoke(
      router(),
      'patch',
      '/:id',
      req({ params: { id }, body: { name: 'Hijack' } }),
    );
    expect(patch.statusCode).toBe(404);
    const del = await invoke(router(), 'delete', '/:id', req({ params: { id } }));
    expect(del.statusCode).toBe(404);
  });

  it('deletes the caller’s own view', async () => {
    const id = ((await create('Temp', ['A'])).jsonBody as { view: { id: string } }).view.id;
    const res = await invoke(router(), 'delete', '/:id', req({ params: { id } }));
    expect(res.statusCode).toBe(200);
    const rows = await harness.db
      .select()
      .from(savedKanbanViews)
      .where(eq(savedKanbanViews.id, id));
    expect(rows).toHaveLength(0);
  });
});
