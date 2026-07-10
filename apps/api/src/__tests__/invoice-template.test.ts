// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0183 — invoice document template CRUD + preview + variables.
// Direct-handler invocation pattern (middleware skipped) like the other
// admin-template tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { invoiceTemplates } from '@vibe/db/schema';

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

describe('0183 invoice template', () => {
  it('returns the shipped default when no row is saved', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'get', '/invoice', makeReq(f));
    const body = r.jsonBody as { isDefault: boolean; template: { bodyHtml: string } };
    expect(body.isDefault).toBe(true);
    expect(body.template.bodyHtml).toContain('class="letterhead"');
  });

  it('lists the variable catalog', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'get', '/invoice/variables', makeReq(f));
    const body = r.jsonBody as { tokens: Array<{ token: string }>; builtinStyles: string[] };
    expect(body.tokens.some((t) => t.token === 'invoice.total')).toBe(true);
    expect(body.builtinStyles).toContain('minimal');
  });

  it('upserts a custom template and reads it back', async () => {
    const f = await setup();
    const put = await invoke(f.router, 'put', '/invoice', {
      ...makeReq(f),
      body: { bodyHtml: '<p>{{ invoice.number }} for {{ client.name }}</p>', css: 'p{color:red}' },
    });
    expect(put.statusCode).toBe(200);

    const [row] = await harness.db
      .select()
      .from(invoiceTemplates)
      .where(eq(invoiceTemplates.firmId, f.firmId));
    expect(row!.bodyHtml).toContain('{{ invoice.number }}');
    // Variables mined from the body for the picker badge.
    expect(row!.variablesJson).toEqual(expect.arrayContaining(['invoice.number', 'client.name']));

    const get = await invoke(f.router, 'get', '/invoice', makeReq(f));
    const body = get.jsonBody as { isDefault: boolean; template: { css: string } };
    expect(body.isDefault).toBe(false);
    expect(body.template.css).toBe('p{color:red}');
  });

  it('second PUT updates the same row (one per firm)', async () => {
    const f = await setup();
    await invoke(f.router, 'put', '/invoice', { ...makeReq(f), body: { bodyHtml: '<p>one</p>' } });
    await invoke(f.router, 'put', '/invoice', {
      ...makeReq(f),
      body: { builtinStyle: 'classic' },
    });
    const rows = await harness.db
      .select()
      .from(invoiceTemplates)
      .where(eq(invoiceTemplates.firmId, f.firmId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.builtinStyle).toBe('classic');
  });

  it('renders a preview against sample data', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/invoice/preview', {
      ...makeReq(f),
      body: {
        bodyHtml:
          '<h1>{{ invoice.number }}</h1>{{#each line_items}}<li>{{ this.description }}</li>{{/each}}<span>{{ client.name }}</span>',
        css: 'h1{font-size:20px}',
      },
    });
    const html = r.sentBody as string;
    expect(r.headers['Content-Type']).toBe('text/html');
    expect(html).toContain('INV-2025-0042');
    expect(html).toContain('compilation of financial statements');
    // Client name with & is HTML-escaped by the engine.
    expect(html).toContain('Riverside Bakery &amp; Co., LLC');
    expect(html).toContain('<style>');
  });
});
