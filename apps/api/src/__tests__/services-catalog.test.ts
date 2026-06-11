// SPDX-License-Identifier: Elastic-2.0
//
// P02 — Services catalog + tags CRUD tests. Exercise the route
// handlers directly (mock req/res) against a real pglite-backed
// database. The HTTP auth chain is covered by separate tests; this
// suite focuses on the business logic of the service catalog.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { asc, inArray, sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { servicesCatalog } from '@vibe/db/schema';
import { createServiceRouter } from '../services-catalog/routes';
import { createServiceTagRouter } from '../services-catalog/tags';

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
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  get(_h: string): string | undefined;
}

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function makeReq(
  overrides: Partial<Omit<FakeReq, 'staffSession' | 'get'>> & {
    firmId: string;
    appUserId: string;
  },
): FakeReq {
  return {
    body: overrides.body ?? {},
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    staffSession: { firmId: overrides.firmId, appUserId: overrides.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    jsonBody: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
  };
  return res;
}

// Invoke a router by walking its stack to find a matching method+path.
// The actual permission middleware is bypassed in these tests; we
// trust the route handler is the only thing that needs business
// coverage.
async function invoke(
  router: ReturnType<typeof createServiceRouter | typeof createServiceTagRouter>,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const route = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return route.path === path && route.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method.toUpperCase()} ${path}`);
  // Pull the LAST handler — that's the route function. Earlier
  // handlers in the stack are middleware (requirePermission, etc.).
  const route = layer.route as unknown as { stack: { handle: (...args: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

async function setup(): Promise<{
  firmId: string;
  appUserId: string;
  router: ReturnType<typeof createServiceRouter>;
  tagsRouter: ReturnType<typeof createServiceTagRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  // Permission lookups go through DB role assignments. Use the
  // fakeUserRoles override so the test session passes
  // requirePermission. The route stack still invokes them, but our
  // invoke() helper skips middleware and runs the handler directly.
  const router = createServiceRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  const tagsRouter = createServiceTagRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  return { firmId: seed.firmId, appUserId: seed.appUserId, router, tagsRouter };
}

describe('P02 services — create + list', () => {
  it('creates a recurring service and lists it', async () => {
    const f = await setup();
    const create = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {
        name: 'Monthly Bookkeeping',
        category: 'BOOKKEEPING',
        defaultPriceCents: 50000,
        billingType: 'RECURRING',
        recurringInterval: 'MONTHLY',
      },
    });
    expect(create.statusCode).toBe(201);
    const id = (create.jsonBody as { id: string }).id;
    const list = await invoke(f.router, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect(list.statusCode).toBe(200);
    const items = (list.jsonBody as { items: { id: string; name: string }[] }).items;
    expect(items.some((i) => i.id === id && i.name === 'Monthly Bookkeeping')).toBe(true);
  });

  it('rejects RECURRING without an interval', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {
        name: 'Bad',
        category: 'TAX',
        defaultPriceCents: 100,
        billingType: 'RECURRING',
      },
    });
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('recurring_interval_mismatch');
  });

  it('rejects ONE_TIME with an interval set', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {
        name: 'Bad',
        category: 'TAX',
        defaultPriceCents: 100,
        billingType: 'ONE_TIME',
        recurringInterval: 'MONTHLY',
      },
    });
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('recurring_interval_mismatch');
  });

  it('filters by category', async () => {
    const f = await setup();
    await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {
        name: 'Tax Return',
        category: 'TAX',
        defaultPriceCents: 1000,
        billingType: 'ONE_TIME',
      },
    });
    await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {
        name: 'Bookkeeping',
        category: 'BOOKKEEPING',
        defaultPriceCents: 5000,
        billingType: 'RECURRING',
        recurringInterval: 'MONTHLY',
      },
    });
    const res = await invoke(f.router, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      query: { category: 'TAX' },
    });
    const items = (res.jsonBody as { items: { name: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.name).toBe('Tax Return');
  });
});

describe('P02 services — patch + archive + restore', () => {
  it('patches name and price', async () => {
    const f = await setup();
    const create = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'Old', category: 'TAX', defaultPriceCents: 1000, billingType: 'ONE_TIME' },
    });
    const id = (create.jsonBody as { id: string }).id;
    const patch = await invoke(f.router, 'patch', '/:id', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
      body: { name: 'New', defaultPriceCents: 2000 },
    });
    expect(patch.statusCode).toBe(200);
    const r = await harness.db.execute(
      sql`SELECT name, default_price_cents AS price FROM services_catalog WHERE id = ${id}`,
    );
    const row = (r as unknown as { rows: { name: string; price: number }[] }).rows[0]!;
    expect(row.name).toBe('New');
    expect(Number(row.price)).toBe(2000);
  });

  it('archive then restore round-trip; archived rows hidden by default', async () => {
    const f = await setup();
    const create = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'Tmp', category: 'TAX', defaultPriceCents: 100, billingType: 'ONE_TIME' },
    });
    const id = (create.jsonBody as { id: string }).id;
    await invoke(f.router, 'post', '/:id/archive', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    const listDefault = await invoke(f.router, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect(
      (listDefault.jsonBody as { items: { id: string }[] }).items.some((i) => i.id === id),
    ).toBe(false);
    const listAll = await invoke(f.router, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      query: { includeArchived: 'true' },
    });
    expect((listAll.jsonBody as { items: { id: string }[] }).items.some((i) => i.id === id)).toBe(
      true,
    );
    await invoke(f.router, 'post', '/:id/restore', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    const listAfterRestore = await invoke(f.router, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect(
      (listAfterRestore.jsonBody as { items: { id: string }[] }).items.some((i) => i.id === id),
    ).toBe(true);
  });
});

describe('P02 service tags', () => {
  it('creates + lists', async () => {
    const f = await setup();
    const create = await invoke(f.tagsRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'Recurring', color: '#3b82f6' },
    });
    expect(create.statusCode).toBe(201);
    const list = await invoke(f.tagsRouter, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    const items = (list.jsonBody as { items: { name: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.name).toBe('Recurring');
  });

  it('rejects duplicate name (case-insensitive)', async () => {
    const f = await setup();
    await invoke(f.tagsRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'Premium' },
    });
    const second = await invoke(f.tagsRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'PREMIUM' },
    });
    expect(second.statusCode).toBe(409);
    expect((second.jsonBody as { error: string }).error).toBe('tag_name_taken');
  });

  it('rejects invalid color', async () => {
    const f = await setup();
    const r = await invoke(f.tagsRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'BadColor', color: 'blue' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('replace-tags-for-service applies and persists', async () => {
    const f = await setup();
    const svc = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'S', category: 'TAX', defaultPriceCents: 100, billingType: 'ONE_TIME' },
    });
    const svcId = (svc.jsonBody as { id: string }).id;
    const t1 = await invoke(f.tagsRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'Annual' },
    });
    const t2 = await invoke(f.tagsRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'Premium' },
    });
    const tag1 = (t1.jsonBody as { id: string }).id;
    const tag2 = (t2.jsonBody as { id: string }).id;
    const setTags = await invoke(f.router, 'post', '/:id/tags', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: svcId } }),
      body: { tagIds: [tag1, tag2] },
    });
    expect(setTags.statusCode).toBe(200);
    const get = await invoke(f.router, 'get', '/:id', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: svcId } }),
    });
    const svcOut = (get.jsonBody as { service: { tags: { id: string }[] } }).service;
    expect(svcOut.tags.map((t) => t.id).sort()).toEqual([tag1, tag2].sort());
    // Replace with a smaller set — should drop the missing tag.
    await invoke(f.router, 'post', '/:id/tags', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: svcId } }),
      body: { tagIds: [tag1] },
    });
    const get2 = await invoke(f.router, 'get', '/:id', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: svcId } }),
    });
    const svcOut2 = (get2.jsonBody as { service: { tags: { id: string }[] } }).service;
    expect(svcOut2.tags.map((t) => t.id)).toEqual([tag1]);
  });

  it('filters services by tag', async () => {
    const f = await setup();
    const svc1 = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'Has Tag', category: 'TAX', defaultPriceCents: 100, billingType: 'ONE_TIME' },
    });
    await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'No Tag', category: 'TAX', defaultPriceCents: 100, billingType: 'ONE_TIME' },
    });
    const t = await invoke(f.tagsRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'Tagged' },
    });
    const svc1Id = (svc1.jsonBody as { id: string }).id;
    const tagId = (t.jsonBody as { id: string }).id;
    await invoke(f.router, 'post', '/:id/tags', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: svc1Id } }),
      body: { tagIds: [tagId] },
    });
    const filtered = await invoke(f.router, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      query: { tagId },
    });
    const items = (filtered.jsonBody as { items: { id: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe(svc1Id);
  });
});

describe('P02 bulk price', () => {
  async function seedThree(f: Awaited<ReturnType<typeof setup>>): Promise<string[]> {
    const ids: string[] = [];
    for (const price of [10000, 20000, 30000]) {
      const r = await invoke(f.router, 'post', '/', {
        ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
        body: {
          name: `S${price}`,
          category: 'TAX',
          defaultPriceCents: price,
          billingType: 'ONE_TIME',
        },
      });
      ids.push((r.jsonBody as { id: string }).id);
    }
    return ids;
  }

  it('applies percent delta and updates each row', async () => {
    const f = await setup();
    const ids = await seedThree(f);
    const r = await invoke(f.router, 'post', '/bulk-price', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { serviceIds: ids, deltaPercentBps: 1000 }, // +10%
    });
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { updated: number }).updated).toBe(3);
    const rows = await harness.db
      .select({ p: servicesCatalog.defaultPriceCents })
      .from(servicesCatalog)
      .where(inArray(servicesCatalog.id, ids))
      .orderBy(asc(servicesCatalog.defaultPriceCents));
    const prices = rows.map((x) => Number(x.p));
    expect(prices).toEqual([11000, 22000, 33000]);
  });

  it('applies flat delta and floors at zero', async () => {
    const f = await setup();
    const ids = await seedThree(f);
    const r = await invoke(f.router, 'post', '/bulk-price', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { serviceIds: ids, deltaFlatCents: -15000 },
    });
    expect(r.statusCode).toBe(200);
    const rows = await harness.db
      .select({ p: servicesCatalog.defaultPriceCents })
      .from(servicesCatalog)
      .where(inArray(servicesCatalog.id, ids))
      .orderBy(asc(servicesCatalog.defaultPriceCents));
    const prices = rows.map((x) => Number(x.p));
    // 10000 - 15000 → floor 0, 20000 - 15000 → 5000, 30000 - 15000 → 15000
    expect(prices).toEqual([0, 5000, 15000]);
  });

  it('rejects when both deltas supplied', async () => {
    const f = await setup();
    const ids = await seedThree(f);
    const r = await invoke(f.router, 'post', '/bulk-price', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { serviceIds: ids, deltaFlatCents: 100, deltaPercentBps: 100 },
    });
    expect(r.statusCode).toBe(400);
  });

  it('returns 404 when no service IDs match the firm', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/bulk-price', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {
        serviceIds: ['11111111-1111-1111-1111-111111111111'],
        deltaPercentBps: 100,
      },
    });
    expect(r.statusCode).toBe(404);
  });
});
