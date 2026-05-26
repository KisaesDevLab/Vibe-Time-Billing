// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P24 — Quick-bill CRUD + state machine tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { quickBillLineItems, quickBills } from '@vibe/db/schema';
import { createQuickBillRouter } from '../quick-bills/routes';

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
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
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
  router: ReturnType<typeof createQuickBillRouter>,
  method: 'get' | 'post' | 'patch',
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
  clientId: string;
  router: ReturnType<typeof createQuickBillRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const router = createQuickBillRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  return { firmId: seed.firmId, appUserId: seed.appUserId, clientId: seed.clientId, router };
}

describe('P24 — create + total math', () => {
  it('creates DRAFT with line items + materialized total', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {
        clientId: f.clientId,
        description: 'Quick consulting',
        lines: [
          { name: 'Hour 1', qty: 1, unitPriceCents: 25000 },
          { name: 'Hour 2', qty: 2, unitPriceCents: 10000 },
        ],
      },
    });
    expect(r.statusCode).toBe(201);
    const id = (r.jsonBody as { id: string; totalCents: number }).id;
    expect((r.jsonBody as { totalCents: number }).totalCents).toBe(45000);
    const [qb] = await harness.db.select().from(quickBills).where(eq(quickBills.id, id));
    expect(qb!.state).toBe('DRAFT');
    expect(Number(qb!.totalCents)).toBe(45000);
    const lines = await harness.db
      .select()
      .from(quickBillLineItems)
      .where(eq(quickBillLineItems.quickBillId, id));
    expect(lines.length).toBe(2);
  });

  it('rejects cross-firm clientId', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {
        clientId: '11111111-1111-1111-1111-111111111111',
        lines: [{ name: 'A', qty: 1, unitPriceCents: 100 }],
      },
    });
    expect(r.statusCode).toBe(404);
  });

  it('rejects empty line list', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, lines: [] },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('P24 — state machine', () => {
  async function create(f: Awaited<ReturnType<typeof setup>>): Promise<string> {
    const r = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, lines: [{ name: 'X', qty: 1, unitPriceCents: 5000 }] },
    });
    return (r.jsonBody as { id: string }).id;
  }

  it('DRAFT → SENT → PAID happy path', async () => {
    const f = await setup();
    const id = await create(f);
    const send = await invoke(f.router, 'post', '/:id/send', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    expect(send.statusCode).toBe(200);
    const paid = await invoke(f.router, 'post', '/:id/mark-paid', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    expect(paid.statusCode).toBe(200);
    const [row] = await harness.db.select().from(quickBills).where(eq(quickBills.id, id));
    expect(row!.state).toBe('PAID');
    expect(row!.sentAt).not.toBeNull();
    expect(row!.paidAt).not.toBeNull();
  });

  it('refuses to send a non-DRAFT', async () => {
    const f = await setup();
    const id = await create(f);
    await invoke(f.router, 'post', '/:id/send', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    const second = await invoke(f.router, 'post', '/:id/send', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    expect(second.statusCode).toBe(409);
  });

  it('mark-paid refuses on DRAFT', async () => {
    const f = await setup();
    const id = await create(f);
    const r = await invoke(f.router, 'post', '/:id/mark-paid', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    expect(r.statusCode).toBe(409);
  });

  it('void from DRAFT stamps reason + state', async () => {
    const f = await setup();
    const id = await create(f);
    const v = await invoke(f.router, 'post', '/:id/void', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id },
        body: { reason: 'duplicate entry' },
      }),
    });
    expect(v.statusCode).toBe(200);
    const [row] = await harness.db.select().from(quickBills).where(eq(quickBills.id, id));
    expect(row!.state).toBe('VOID');
    expect(row!.voidReason).toBe('duplicate entry');
  });

  it('void from PAID still allowed (some firms void post-refund)', async () => {
    const f = await setup();
    const id = await create(f);
    await invoke(f.router, 'post', '/:id/send', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    await invoke(f.router, 'post', '/:id/mark-paid', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    const v = await invoke(f.router, 'post', '/:id/void', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id },
        body: { reason: 'refunded out of band' },
      }),
    });
    expect(v.statusCode).toBe(200);
  });

  it('void second time rejected', async () => {
    const f = await setup();
    const id = await create(f);
    await invoke(f.router, 'post', '/:id/void', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id },
        body: { reason: 'a' },
      }),
    });
    const r = await invoke(f.router, 'post', '/:id/void', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id },
        body: { reason: 'b' },
      }),
    });
    expect(r.statusCode).toBe(409);
  });
});

describe('P24 — patch + replace lines', () => {
  async function create(f: Awaited<ReturnType<typeof setup>>): Promise<string> {
    const r = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, lines: [{ name: 'X', qty: 1, unitPriceCents: 100 }] },
    });
    return (r.jsonBody as { id: string }).id;
  }

  it('patch description while DRAFT', async () => {
    const f = await setup();
    const id = await create(f);
    const p = await invoke(f.router, 'patch', '/:id', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id },
        body: { description: 'updated' },
      }),
    });
    expect(p.statusCode).toBe(200);
    const [row] = await harness.db.select().from(quickBills).where(eq(quickBills.id, id));
    expect(row!.description).toBe('updated');
  });

  it('replace lines recomputes total', async () => {
    const f = await setup();
    const id = await create(f);
    const r = await invoke(f.router, 'post', '/:id/lines', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id },
        body: {
          lines: [
            { name: 'New 1', qty: 3, unitPriceCents: 10000 },
            { name: 'New 2', qty: 1, unitPriceCents: 5000 },
          ],
        },
      }),
    });
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { totalCents: number }).totalCents).toBe(35000);
    const [row] = await harness.db.select().from(quickBills).where(eq(quickBills.id, id));
    expect(Number(row!.totalCents)).toBe(35000);
  });

  it('patch refused on non-DRAFT', async () => {
    const f = await setup();
    const id = await create(f);
    await invoke(f.router, 'post', '/:id/send', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    const p = await invoke(f.router, 'patch', '/:id', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id },
        body: { description: 'late' },
      }),
    });
    expect(p.statusCode).toBe(409);
  });
});

describe('P24 — list + filter', () => {
  it('filters by state', async () => {
    const f = await setup();
    const r1 = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, lines: [{ name: 'A', qty: 1, unitPriceCents: 100 }] },
    });
    await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, lines: [{ name: 'B', qty: 1, unitPriceCents: 200 }] },
    });
    await invoke(f.router, 'post', '/:id/send', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id: (r1.jsonBody as { id: string }).id },
      }),
    });
    const draftOnly = await invoke(f.router, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, query: { state: 'DRAFT' } }),
    });
    const draftItems = (draftOnly.jsonBody as { items: { state: string }[] }).items;
    expect(draftItems.length).toBe(1);
    expect(draftItems[0]!.state).toBe('DRAFT');
  });
});
