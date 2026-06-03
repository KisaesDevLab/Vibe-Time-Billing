// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Knowledge base (Help) routes: read/search are open to any staff;
// article CRUD requires kb:manage.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type express from 'express';

import { and, eq } from 'drizzle-orm';

import { seedKnowledgeBase } from '@vibe/db';
import { kbArticles } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createHelpRouter } from '../help/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeAll(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await seedKnowledgeBase(harness.db, seed.firmId);
});

afterAll(async () => {
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
  method: 'get' | 'post' | 'patch',
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
  // Run each middleware (e.g. requirePermission) to completion. If one
  // short-circuits without calling next() (a 403), stop. Then await the
  // final handler. This properly awaits async handlers, unlike a naive
  // fire-and-forget next().
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
function req(
  firmId: string,
  appUserId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { body: {}, params: {}, query: {}, staffSession: { firmId, appUserId }, ...extra };
}

describe('help (knowledge base) routes', () => {
  it('GET /categories returns seeded categories with article counts', async () => {
    const router = createHelpRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['staff']]]),
    });
    const r = await invoke(router, 'get', '/categories', req(seed.firmId, seed.appUserId));
    expect(r.statusCode).toBe(200);
    const cats = (r.jsonBody as { categories: Array<{ slug: string; articleCount: number }> })
      .categories;
    expect(cats.length).toBeGreaterThan(5);
    const gs = cats.find((c) => c.slug === 'getting-started');
    expect(gs).toBeTruthy();
    expect(gs!.articleCount).toBeGreaterThan(0);
  });

  it('GET /articles?category= lists published articles in a category', async () => {
    const router = createHelpRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['staff']]]),
    });
    const r = await invoke(
      router,
      'get',
      '/articles',
      req(seed.firmId, seed.appUserId, { query: { category: 'getting-started' } }),
    );
    const arts = (r.jsonBody as { articles: Array<{ slug: string }> }).articles;
    expect(arts.some((a) => a.slug === 'signing-in')).toBe(true);
  });

  it('GET /articles?q= searches title/body', async () => {
    const router = createHelpRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['staff']]]),
    });
    const r = await invoke(
      router,
      'get',
      '/articles',
      req(seed.firmId, seed.appUserId, { query: { q: 'portal' } }),
    );
    const arts = (r.jsonBody as { articles: Array<{ slug: string }> }).articles;
    expect(arts.length).toBeGreaterThan(0);
    expect(arts.some((a) => a.slug.includes('portal'))).toBe(true);
  });

  it('GET /articles/:slug returns the full body', async () => {
    const router = createHelpRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['staff']]]),
    });
    const r = await invoke(
      router,
      'get',
      '/articles/:slug',
      req(seed.firmId, seed.appUserId, { params: { slug: 'welcome' } }),
    );
    expect(r.statusCode).toBe(200);
    const a = (r.jsonBody as { article: { bodyMarkdown: string } }).article;
    expect(a.bodyMarkdown.length).toBeGreaterThan(20);
  });

  it('POST /articles requires kb:manage (403 for staff, ok for admin)', async () => {
    const body = {
      slug: 'firm-note',
      title: 'Firm note',
      bodyMarkdown: 'Internal note for our staff.',
      status: 'PUBLISHED',
    };

    const staffRouter = createHelpRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['staff']]]),
    });
    const denied = await invoke(
      staffRouter,
      'post',
      '/articles',
      req(seed.firmId, seed.appUserId, { body }),
    );
    expect(denied.statusCode).toBe(403);

    const adminRouter = createHelpRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
    });
    const ok = await invoke(
      adminRouter,
      'post',
      '/articles',
      req(seed.firmId, seed.appUserId, { body }),
    );
    expect(ok.statusCode).toBe(200);

    // Diagnostic: confirm the row persisted via a direct query (isolates the
    // write path from the manage endpoint).
    const direct = await harness.db
      .select({ slug: kbArticles.slug, isSystem: kbArticles.isSystem })
      .from(kbArticles)
      .where(and(eq(kbArticles.firmId, seed.firmId), eq(kbArticles.slug, 'firm-note')));
    expect(direct[0]?.isSystem).toBe(false);

    // It now shows up in the manage list.
    const list = await invoke(
      adminRouter,
      'get',
      '/manage/articles',
      req(seed.firmId, seed.appUserId),
    );
    const arts =
      (list.jsonBody as { articles?: Array<{ slug: string; isSystem: boolean }> }).articles ?? [];
    const created = arts.find((a) => a.slug === 'firm-note');
    expect(created).toBeTruthy();
    expect(created!.isSystem).toBe(false);
  });
});
