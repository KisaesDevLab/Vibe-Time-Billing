// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P03 — Packages CRUD + tier math tests. Direct-handler invocation
// against a real pglite-backed Drizzle harness. Mirrors the test
// shape used in services-catalog.test.ts.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { packageServices, packages } from '@vibe/db/schema';
import { createPackageRouter } from '../packages/routes';
import { createServiceRouter } from '../services-catalog/routes';

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

function makeReq(o: { firmId: string; appUserId: string } & Partial<FakeReq>): FakeReq {
  return {
    body: o.body ?? {},
    params: o.params ?? {},
    query: o.query ?? {},
    staffSession: { firmId: o.firmId, appUserId: o.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}
function makeRes(): FakeRes {
  const r: FakeRes = {
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
  return r;
}

async function invoke(
  router: ReturnType<typeof createPackageRouter | typeof createServiceRouter>,
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
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

async function setup(): Promise<{
  firmId: string;
  appUserId: string;
  pkgRouter: ReturnType<typeof createPackageRouter>;
  svcRouter: ReturnType<typeof createServiceRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const pkgRouter = createPackageRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  const svcRouter = createServiceRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  return { firmId: seed.firmId, appUserId: seed.appUserId, pkgRouter, svcRouter };
}

async function createService(
  f: Awaited<ReturnType<typeof setup>>,
  name: string,
  priceCents: number,
): Promise<string> {
  const r = await invoke(f.svcRouter, 'post', '/', {
    ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    body: { name, category: 'TAX', defaultPriceCents: priceCents, billingType: 'ONE_TIME' },
  });
  return (r.jsonBody as { id: string }).id;
}

describe('P03 package — create + list + total math', () => {
  it('creates a package and totals included entries', async () => {
    const f = await setup();
    const svc1 = await createService(f, 'Federal 1040', 60000);
    const svc2 = await createService(f, 'State return', 20000);
    const svc3 = await createService(f, 'Cash-flow projection', 40000); // not included

    const create = await invoke(f.pkgRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'Small Biz Tax', tierLabel: 'Bronze' },
    });
    expect(create.statusCode).toBe(201);
    const pkgId = (create.jsonBody as { id: string }).id;

    const set = await invoke(f.pkgRouter, 'post', '/:id/services', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: pkgId } }),
      body: {
        entries: [
          { serviceId: svc1, included: true, sequence: 0 },
          { serviceId: svc2, overridePriceCents: 15000, included: true, sequence: 1 },
          { serviceId: svc3, included: false, sequence: 2 },
        ],
      },
    });
    expect(set.statusCode).toBe(200);

    const list = await invoke(f.pkgRouter, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    const items = (
      list.jsonBody as {
        items: { id: string; totalIncludedCents: number; includedServiceCount: number }[];
      }
    ).items;
    const ours = items.find((i) => i.id === pkgId);
    expect(ours).toBeTruthy();
    // 60000 (default) + 15000 (override) = 75000. svc3 excluded.
    expect(Number(ours!.totalIncludedCents)).toBe(75000);
    expect(ours!.includedServiceCount).toBe(2);
  });

  it('detail endpoint returns each entry with merged price fields', async () => {
    const f = await setup();
    const svc = await createService(f, 'S', 10000);
    const create = await invoke(f.pkgRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'P', tierLabel: 'Bronze' },
    });
    const pkgId = (create.jsonBody as { id: string }).id;
    await invoke(f.pkgRouter, 'post', '/:id/services', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: pkgId } }),
      body: { entries: [{ serviceId: svc, overridePriceCents: 8000, included: true }] },
    });
    const get = await invoke(f.pkgRouter, 'get', '/:id', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: pkgId } }),
    });
    const body = get.jsonBody as {
      entries: {
        serviceName: string;
        serviceDefaultPriceCents: number;
        overridePriceCents: number | null;
        included: boolean;
      }[];
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.serviceName).toBe('S');
    expect(Number(body.entries[0]!.serviceDefaultPriceCents)).toBe(10000);
    expect(Number(body.entries[0]!.overridePriceCents)).toBe(8000);
    expect(body.entries[0]!.included).toBe(true);
  });
});

describe('P03 package — groupByName preview', () => {
  it('groups 3 tier rows under one name', async () => {
    const f = await setup();
    for (const [tier, pos] of [
      ['Bronze', 0],
      ['Silver', 1],
      ['Gold', 2],
    ] as const) {
      await invoke(f.pkgRouter, 'post', '/', {
        ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
        body: { name: 'Small Biz Tax', tierLabel: tier, position: pos },
      });
    }
    const r = await invoke(f.pkgRouter, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      query: { groupByName: 'true' },
    });
    const groups = (r.jsonBody as { groups: Record<string, { tierLabel: string }[]> }).groups;
    expect(Object.keys(groups)).toEqual(['Small Biz Tax']);
    expect(groups['Small Biz Tax']!.map((g) => g.tierLabel)).toEqual(['Bronze', 'Silver', 'Gold']);
  });
});

describe('P03 package — services replace', () => {
  it('replace clears prior entries', async () => {
    const f = await setup();
    const a = await createService(f, 'A', 100);
    const b = await createService(f, 'B', 200);
    const create = await invoke(f.pkgRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'P' },
    });
    const pkgId = (create.jsonBody as { id: string }).id;
    await invoke(f.pkgRouter, 'post', '/:id/services', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: pkgId } }),
      body: { entries: [{ serviceId: a }, { serviceId: b }] },
    });
    // Replace with just A — B should be gone.
    await invoke(f.pkgRouter, 'post', '/:id/services', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: pkgId } }),
      body: { entries: [{ serviceId: a }] },
    });
    const entries = await harness.db
      .select()
      .from(packageServices)
      .where(eq(packageServices.packageId, pkgId));
    expect(entries.length).toBe(1);
    expect(entries[0]!.serviceId).toBe(a);
  });

  it('rejects duplicate serviceId in same payload', async () => {
    const f = await setup();
    const a = await createService(f, 'A', 100);
    const create = await invoke(f.pkgRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'P' },
    });
    const pkgId = (create.jsonBody as { id: string }).id;
    const r = await invoke(f.pkgRouter, 'post', '/:id/services', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: pkgId } }),
      body: { entries: [{ serviceId: a }, { serviceId: a }] },
    });
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('duplicate_service_id');
  });

  it('rejects service from another firm', async () => {
    const f = await setup();
    const create = await invoke(f.pkgRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'P' },
    });
    const pkgId = (create.jsonBody as { id: string }).id;
    // Random uuid that doesn't exist as a service.
    const r = await invoke(f.pkgRouter, 'post', '/:id/services', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: pkgId } }),
      body: { entries: [{ serviceId: '11111111-1111-1111-1111-111111111111' }] },
    });
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('service_not_in_firm');
  });
});

describe('P03 package — duplicate', () => {
  it('clones header + services into a sibling row', async () => {
    const f = await setup();
    const svc = await createService(f, 'S', 1000);
    const src = await invoke(f.pkgRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'Source', tierLabel: 'Bronze', position: 0 },
    });
    const srcId = (src.jsonBody as { id: string }).id;
    await invoke(f.pkgRouter, 'post', '/:id/services', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: srcId } }),
      body: { entries: [{ serviceId: svc, included: true }] },
    });
    const dup = await invoke(f.pkgRouter, 'post', '/:id/duplicate', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: srcId } }),
      body: { tierLabel: 'Silver', position: 1 },
    });
    expect(dup.statusCode).toBe(201);
    const cloneId = (dup.jsonBody as { id: string }).id;
    expect(cloneId).not.toBe(srcId);
    const [cloneRow] = await harness.db.select().from(packages).where(eq(packages.id, cloneId));
    expect(cloneRow!.tierLabel).toBe('Silver');
    expect(cloneRow!.position).toBe(1);
    expect(cloneRow!.name).toBe('Source (copy)');
    const cloneEntries = await harness.db
      .select()
      .from(packageServices)
      .where(eq(packageServices.packageId, cloneId));
    expect(cloneEntries.length).toBe(1);
    expect(cloneEntries[0]!.serviceId).toBe(svc);
  });
});

describe('P03 package — archive / restore', () => {
  it('archived rows hidden by default, surfaced via flag, restorable', async () => {
    const f = await setup();
    const r = await invoke(f.pkgRouter, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { name: 'Tmp' },
    });
    const id = (r.jsonBody as { id: string }).id;
    await invoke(f.pkgRouter, 'post', '/:id/archive', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    const list = await invoke(f.pkgRouter, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect(
      (list.jsonBody as { items: { id: string }[] }).items.find((i) => i.id === id),
    ).toBeFalsy();
    const listAll = await invoke(f.pkgRouter, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      query: { includeArchived: 'true' },
    });
    expect(
      (listAll.jsonBody as { items: { id: string }[] }).items.find((i) => i.id === id),
    ).toBeTruthy();
    await invoke(f.pkgRouter, 'post', '/:id/restore', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    const after = await invoke(f.pkgRouter, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect(
      (after.jsonBody as { items: { id: string }[] }).items.find((i) => i.id === id),
    ).toBeTruthy();
  });
});
