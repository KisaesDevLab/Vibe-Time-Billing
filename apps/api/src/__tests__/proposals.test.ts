// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// PP4a — Proposal CRUD route tests (direct-handler invocation
// against pglite-backed Drizzle harness). Block-tree validation is
// tested in @vibe/core/proposals/blocks.test.ts; here we cover the
// route surface.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { proposals } from '@vibe/db/schema';
import { createProposalRouter } from '../proposals/routes';

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
  router: ReturnType<typeof createProposalRouter>,
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
  clientId: string;
  router: ReturnType<typeof createProposalRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const router = createProposalRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  return { firmId: seed.firmId, appUserId: seed.appUserId, clientId: seed.clientId, router };
}

describe('PP4a — create + list', () => {
  it('creates a DRAFT proposal with an empty block tree', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, title: 'Annual Tax 2026' },
    });
    expect(r.statusCode).toBe(201);
    const id = (r.jsonBody as { id: string }).id;
    const [row] = await harness.db.select().from(proposals).where(eq(proposals.id, id));
    expect(row!.status).toBe('DRAFT');
    expect(row!.title).toBe('Annual Tax 2026');
    expect(row!.draftRevision).toBe(0);
    expect(row!.brochureJsonb).toMatchObject({ blocks: [], schemaVersion: 1 });
  });

  it('rejects cross-firm clientId', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: '11111111-1111-1111-1111-111111111111', title: 'X' },
    });
    expect(r.statusCode).toBe(404);
    expect((r.jsonBody as { error: string }).error).toBe('client_not_found');
  });

  it('lists with client name hydrated, filterable by status', async () => {
    const f = await setup();
    await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, title: 'A' },
    });
    await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, title: 'B' },
    });
    const list = await invoke(f.router, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    const items = (
      list.jsonBody as { items: { title: string; clientName: string; status: string }[] }
    ).items;
    expect(items.length).toBe(2);
    expect(items[0]!.clientName).toBe('Test Client Co');
    // status filter
    const draft = await invoke(f.router, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      query: { status: 'DRAFT' },
    });
    expect((draft.jsonBody as { items: unknown[] }).items.length).toBe(2);
    const accepted = await invoke(f.router, 'get', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      query: { status: 'ACCEPTED' },
    });
    expect((accepted.jsonBody as { items: unknown[] }).items.length).toBe(0);
  });
});

describe('PP4a — patch (title)', () => {
  it('updates title on DRAFT', async () => {
    const f = await setup();
    const c = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, title: 'Old' },
    });
    const id = (c.jsonBody as { id: string }).id;
    const r = await invoke(f.router, 'patch', '/:id', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
      body: { title: 'New' },
    });
    expect(r.statusCode).toBe(200);
    const [row] = await harness.db.select().from(proposals).where(eq(proposals.id, id));
    expect(row!.title).toBe('New');
  });

  it('refuses to patch a non-DRAFT proposal', async () => {
    const f = await setup();
    const c = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, title: 'X' },
    });
    const id = (c.jsonBody as { id: string }).id;
    // Bump status via SQL.
    await harness.db
      .update(proposals)
      .set({ status: 'SENT', sentAt: new Date() })
      .where(eq(proposals.id, id));
    const r = await invoke(f.router, 'patch', '/:id', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
      body: { title: 'Y' },
    });
    expect(r.statusCode).toBe(409);
  });
});

describe('PP4a — brochure save', () => {
  it('persists block tree and bumps draft_revision', async () => {
    const f = await setup();
    const c = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, title: 'B' },
    });
    const id = (c.jsonBody as { id: string }).id;
    const tree = {
      schemaVersion: 1,
      blocks: [
        { id: 'b1', type: 'text', position: 0, props: { md: 'Hello' } },
        { id: 'b2', type: 'divider', position: 1, props: {} },
      ],
    };
    const r = await invoke(f.router, 'post', '/:id/brochure', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
      body: { brochureJsonb: tree },
    });
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { draftRevision: number }).draftRevision).toBe(1);
    const [row] = await harness.db.select().from(proposals).where(eq(proposals.id, id));
    expect(row!.draftRevision).toBe(1);
    expect(row!.brochureJsonb).toMatchObject(tree);
    // Second save bumps to 2.
    const r2 = await invoke(f.router, 'post', '/:id/brochure', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
      body: { brochureJsonb: { schemaVersion: 1, blocks: [] } },
    });
    expect((r2.jsonBody as { draftRevision: number }).draftRevision).toBe(2);
  });

  it('rejects invalid block tree shape', async () => {
    const f = await setup();
    const c = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, title: 'B' },
    });
    const id = (c.jsonBody as { id: string }).id;
    const r = await invoke(f.router, 'post', '/:id/brochure', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
      body: { brochureJsonb: { schemaVersion: 99, blocks: [] } },
    });
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('invalid_block_tree');
  });

  it('refuses to save brochure on non-DRAFT proposal', async () => {
    const f = await setup();
    const c = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, title: 'B' },
    });
    const id = (c.jsonBody as { id: string }).id;
    await harness.db
      .update(proposals)
      .set({ status: 'SENT', sentAt: new Date() })
      .where(eq(proposals.id, id));
    const r = await invoke(f.router, 'post', '/:id/brochure', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
      body: { brochureJsonb: { schemaVersion: 1, blocks: [] } },
    });
    expect(r.statusCode).toBe(409);
  });
});

describe('PP4a — archive', () => {
  it('cancels a DRAFT proposal', async () => {
    const f = await setup();
    const c = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, title: 'B' },
    });
    const id = (c.jsonBody as { id: string }).id;
    await invoke(f.router, 'post', '/:id/archive', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    const [row] = await harness.db.select().from(proposals).where(eq(proposals.id, id));
    expect(row!.status).toBe('CANCELLED');
    expect(row!.cancelledAt).not.toBeNull();
    expect(row!.cancelledById).toBe(f.appUserId);
  });

  it('refuses to archive ACCEPTED proposals', async () => {
    const f = await setup();
    const c = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { clientId: f.clientId, title: 'B' },
    });
    const id = (c.jsonBody as { id: string }).id;
    await harness.db
      .update(proposals)
      .set({ status: 'ACCEPTED', acceptedAt: new Date() })
      .where(eq(proposals.id, id));
    const r = await invoke(f.router, 'post', '/:id/archive', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    expect(r.statusCode).toBe(409);
  });
});
