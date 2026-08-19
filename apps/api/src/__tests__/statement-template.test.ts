// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0184 — statement document template CRUD + preview + variables.
// Direct-handler invocation (middleware skipped) like invoice-template.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { statementTemplates } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTemplateRouter } from '../admin/templates';

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
  sentBody: unknown;
  headers: Record<string, string>;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  send(b: unknown): FakeRes;
  setHeader(k: string, v: string): void;
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
    sentBody: undefined,
    headers: {},
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
    send(b) {
      this.sentBody = b;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
  };
  return r;
}

async function invoke(
  router: ReturnType<typeof createTemplateRouter>,
  method: 'get' | 'post' | 'put',
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
  await (handler as (req: unknown, res: unknown) => Promise<void> | void)(req, res);
  return res;
}

async function setup(): Promise<{
  firmId: string;
  appUserId: string;
  router: ReturnType<typeof createTemplateRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const router = createTemplateRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  return { firmId: seed.firmId, appUserId: seed.appUserId, router };
}

describe('0184 statement template', () => {
  it('returns the shipped default when no row is saved', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'get', '/statement', makeReq(f));
    const body = r.jsonBody as { isDefault: boolean; template: { bodyHtml: string } };
    expect(body.isDefault).toBe(true);
    expect(body.template.bodyHtml).toContain('Statement of Account');
  });

  it('lists the statement variable catalog', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'get', '/statement/variables', makeReq(f));
    const body = r.jsonBody as { tokens: Array<{ token: string }>; builtinStyles: string[] };
    expect(body.tokens.some((t) => t.token === 'statement.closing_balance')).toBe(true);
    expect(body.tokens.some((t) => t.token === 'aging.d_0_30')).toBe(true);
    expect(body.builtinStyles).toContain('classic');
  });

  it('upserts and reads back; second PUT updates the same row', async () => {
    const f = await setup();
    await invoke(f.router, 'put', '/statement', {
      ...makeReq(f),
      body: { bodyHtml: '<p>{{ client.name }} owes {{ statement.total_due }}</p>', css: 'p{}' },
    });
    const [row] = await harness.db
      .select()
      .from(statementTemplates)
      .where(eq(statementTemplates.firmId, f.firmId));
    expect(row!.variablesJson).toEqual(
      expect.arrayContaining(['client.name', 'statement.total_due']),
    );

    await invoke(f.router, 'put', '/statement', {
      ...makeReq(f),
      body: { builtinStyle: 'classic' },
    });
    const rows = await harness.db
      .select()
      .from(statementTemplates)
      .where(eq(statementTemplates.firmId, f.firmId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.builtinStyle).toBe('classic');
  });

  it('renders a preview against the built-in sample (no invoices)', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/statement/preview', {
      ...makeReq(f),
      body: {
        bodyHtml:
          '<h1>Statement of Account</h1>{{#each lines}}<li>{{ this.type }} {{ this.balance }}</li>{{/each}}<span>{{ client.name }}</span>',
        css: 'h1{}',
      },
    });
    const html = r.sentBody as string;
    expect(r.headers['Content-Type']).toBe('text/html');
    expect(html).toContain('Statement of Account');
    expect(html).toContain('Riverside Bakery &amp; Co., LLC');
    expect(html).toContain('Invoice');
    expect(html).toContain('<style>');
  });

  it('sample fallback shows the real firm identity, not the built-in one', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/statement/preview', {
      ...makeReq(f),
      body: {
        bodyHtml: '<h1>{{ firm.name }}</h1><span>{{ client.name }}</span>',
        css: 'h1{}',
      },
    });
    const html = r.sentBody as string;
    // Firm block comes from the seeded firm; client/lines stay sample data.
    expect(html).toContain('Test Firm');
    expect(html).not.toContain('Northwind');
    expect(html).toContain('Riverside Bakery &amp; Co., LLC');
  });
});
