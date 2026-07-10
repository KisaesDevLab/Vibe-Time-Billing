// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P07 — Terms templates CRUD + seed-starters + preview tests.
// Same direct-handler invocation pattern as services-catalog +
// packages tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { termsTemplates } from '@vibe/db/schema';
import { createTermsTemplateRouter } from '../terms-templates/routes';

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
  router: ReturnType<typeof createTermsTemplateRouter>,
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
  router: ReturnType<typeof createTermsTemplateRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const router = createTermsTemplateRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  return { firmId: seed.firmId, appUserId: seed.appUserId, router };
}

describe('P07 terms — create + patch (version bump)', () => {
  it('creates v1 and bumps to v2 on patch', async () => {
    const f = await setup();
    const create = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { category: 'TAX', name: 'Custom Tax', contentMd: 'Initial body' },
    });
    expect(create.statusCode).toBe(201);
    const id = (create.jsonBody as { id: string }).id;
    const patch = await invoke(f.router, 'patch', '/:id', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
      body: { contentMd: 'Updated body' },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.jsonBody as { version: number }).version).toBe(2);
    const [row] = await harness.db.select().from(termsTemplates).where(eq(termsTemplates.id, id));
    expect(row!.version).toBe(2);
    expect(row!.contentMd).toBe('Updated body');
  });

  it('rejects empty name', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { category: 'TAX', name: '' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('P07 terms — defaults per category', () => {
  it('isDefault on create displaces prior default in same category', async () => {
    const f = await setup();
    const a = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { category: 'TAX', name: 'A', isDefault: true },
    });
    const idA = (a.jsonBody as { id: string }).id;
    const b = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { category: 'TAX', name: 'B', isDefault: true },
    });
    expect(b.statusCode).toBe(201);
    const rows = await harness.db
      .select()
      .from(termsTemplates)
      .where(and(eq(termsTemplates.firmId, f.firmId), eq(termsTemplates.category, 'TAX')));
    const defaults = rows.filter((r) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.name).toBe('B');
    // A is no longer default.
    const [rowA] = rows.filter((r) => r.id === idA);
    expect(rowA!.isDefault).toBe(false);
  });

  it('make-default flips active default within a category', async () => {
    const f = await setup();
    const a = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { category: 'BOOKKEEPING', name: 'A', isDefault: true },
    });
    const b = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { category: 'BOOKKEEPING', name: 'B' },
    });
    const idA = (a.jsonBody as { id: string }).id;
    const idB = (b.jsonBody as { id: string }).id;
    await invoke(f.router, 'post', '/:id/make-default', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: idB } }),
    });
    const rows = await harness.db
      .select()
      .from(termsTemplates)
      .where(eq(termsTemplates.firmId, f.firmId));
    const map = new Map(rows.map((r) => [r.id, r]));
    expect(map.get(idA)!.isDefault).toBe(false);
    expect(map.get(idB)!.isDefault).toBe(true);
  });

  it('make-default refuses to act on archived row', async () => {
    const f = await setup();
    const c = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { category: 'TAX', name: 'C' },
    });
    const id = (c.jsonBody as { id: string }).id;
    await invoke(f.router, 'post', '/:id/archive', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    const r = await invoke(f.router, 'post', '/:id/make-default', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
    });
    expect(r.statusCode).toBe(409);
  });
});

describe('P07 terms — archive clears default flag', () => {
  it('archiving a default frees the category for a new one', async () => {
    const f = await setup();
    const a = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { category: 'CFO', name: 'A', isDefault: true },
    });
    const idA = (a.jsonBody as { id: string }).id;
    await invoke(f.router, 'post', '/:id/archive', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: idA } }),
    });
    // After archive, isDefault is false on A so partial unique index
    // permits a new default for the same category.
    const b = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { category: 'CFO', name: 'B', isDefault: true },
    });
    expect(b.statusCode).toBe(201);
  });
});

describe('P07 terms — seed-starters', () => {
  it('inserts 6 starter templates, marks one default per category', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/seed-starters', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { inserted: number }).inserted).toBe(6);
    const rows = await harness.db
      .select()
      .from(termsTemplates)
      .where(and(eq(termsTemplates.firmId, f.firmId), isNull(termsTemplates.archivedAt)));
    expect(rows.length).toBe(6);
    const cats = new Set(rows.filter((row) => row.isDefault).map((row) => row.category));
    expect(cats.size).toBe(6);
    expect(Array.from(cats).sort()).toEqual([
      'ADVISORY',
      'AUDIT',
      'BOOKKEEPING',
      'CFO',
      'PAYROLL',
      'TAX',
    ]);
  });

  it('idempotent — second call inserts zero', async () => {
    const f = await setup();
    await invoke(f.router, 'post', '/seed-starters', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    const second = await invoke(f.router, 'post', '/seed-starters', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect((second.jsonBody as { inserted: number; skipped: number }).inserted).toBe(0);
    expect((second.jsonBody as { skipped: number }).skipped).toBe(6);
  });

  it('does not stomp pre-existing default in a category', async () => {
    const f = await setup();
    // Create a TAX default first.
    await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: { category: 'TAX', name: 'Existing TAX default', isDefault: true },
    });
    await invoke(f.router, 'post', '/seed-starters', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    const rows = await harness.db
      .select()
      .from(termsTemplates)
      .where(
        and(
          eq(termsTemplates.firmId, f.firmId),
          eq(termsTemplates.category, 'TAX'),
          eq(termsTemplates.isDefault, true),
          isNull(termsTemplates.archivedAt),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Existing TAX default');
  });
});

describe('P07 terms — preview', () => {
  it('resolves merge tokens and reports unresolved', async () => {
    const f = await setup();
    const create = await invoke(f.router, 'post', '/', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {
        category: 'TAX',
        name: 'Preview Test',
        contentMd:
          'Hello {{client.name}} — from {{firm.name}} on {{today}}. Missing: {{client.age}}',
      },
    });
    const id = (create.jsonBody as { id: string }).id;
    const r = await invoke(f.router, 'post', '/:id/preview', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id } }),
      body: {
        context: {
          client: { name: 'Acme Co' },
          firm: { name: 'Smith CPAs' },
          today: '2026-05-25',
        },
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { output: string; unresolvedTokens: string[]; version: number };
    expect(body.output).toBe('Hello Acme Co — from Smith CPAs on 2026-05-25. Missing: ');
    expect(body.unresolvedTokens).toEqual(['client.age']);
    expect(body.version).toBe(1);
  });
});
