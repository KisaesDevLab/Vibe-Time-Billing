// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0084 — request templates CRUD + items replace + cross-firm guards.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { requestTemplateItems, requestTemplates } from '@vibe/db/schema';
import { createRequestTemplateRouter } from '../requests/templates';

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
  headers: Record<string, string>;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  header(name: string): string | undefined;
  get(name: string): string | undefined;
}
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
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

function req(over: Partial<FakeReq> & { firmId: string; appUserId: string }): FakeReq {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: over.firmId, appUserId: over.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
    ...over,
  };
}

describe('request templates router', () => {
  it('POST creates a template with items in one tx', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestTemplateRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          key: 'year-end-docs',
          name: 'Year-end docs',
          titlePattern: 'Year-end docs for {{client.name}} ({{today}})',
          bodyPattern: 'Please upload everything below.',
          defaultPriority: 'HIGH',
          defaultDueOffsetDays: 14,
          defaultReminderDaysBefore: 3,
          items: [
            { ordinal: 0, label: 'W-2', itemKind: 'DOCUMENT', required: true },
            { ordinal: 1, label: '1099s', itemKind: 'DOCUMENT', required: true },
            { ordinal: 2, label: 'Mortgage interest?', itemKind: 'QUESTION', required: false },
          ],
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const id = (r.jsonBody as { id: string }).id;
    const [tpl] = await harness.db
      .select()
      .from(requestTemplates)
      .where(eq(requestTemplates.id, id));
    expect(tpl!.titlePattern).toContain('Year-end');
    expect(tpl!.defaultPriority).toBe('HIGH');
    expect(tpl!.defaultDueOffsetDays).toBe(14);
    const items = await harness.db
      .select()
      .from(requestTemplateItems)
      .where(eq(requestTemplateItems.templateId, id));
    expect(items).toHaveLength(3);
  });

  it('GET lists firm templates with their items', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestTemplateRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          key: 'k1',
          name: 'T1',
          titlePattern: 'X',
          items: [{ ordinal: 0, label: 'Q1' }],
        },
      }),
    });
    const list = await invoke(router, 'get', '/', {
      ...req({ firmId: seed.firmId, appUserId: seed.appUserId }),
    });
    const body = list.jsonBody as {
      items: Array<{ name: string; items: Array<{ label: string }> }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.items).toHaveLength(1);
    expect(body.items[0]!.items[0]!.label).toBe('Q1');
  });

  it('POST /:id/items replaces the items list', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestTemplateRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const create = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          key: 'k2',
          name: 'T',
          titlePattern: 'X',
          items: [{ ordinal: 0, label: 'old' }],
        },
      }),
    });
    const id = (create.jsonBody as { id: string }).id;
    const replace = await invoke(router, 'post', '/:id/items', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id },
        body: {
          items: [
            { ordinal: 0, label: 'new-1' },
            { ordinal: 1, label: 'new-2' },
          ],
        },
      }),
    });
    expect(replace.statusCode).toBe(200);
    const items = await harness.db
      .select()
      .from(requestTemplateItems)
      .where(eq(requestTemplateItems.templateId, id));
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.label).sort()).toEqual(['new-1', 'new-2']);
  });

  it('cross-firm PATCH → 404', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestTemplateRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const create = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: { key: 'k', name: 'T', titlePattern: 'X' },
      }),
    });
    const id = (create.jsonBody as { id: string }).id;
    const other = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other') RETURNING id`,
    );
    const otherFirmId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@x.example', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherRouter = createRequestTemplateRouter({
      db: harness.db,
      fakeUserRoles: new Map([[otherUserId, ['partner']]]),
    });
    const r = await invoke(otherRouter, 'patch', '/:id', {
      ...req({
        firmId: otherFirmId,
        appUserId: otherUserId,
        params: { id },
        body: { name: 'hijacked' },
      }),
    });
    expect(r.statusCode).toBe(404);
  });

  it('PATCH /:id/archive flips status', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestTemplateRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const create = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: { key: 'k', name: 'T', titlePattern: 'X' },
      }),
    });
    const id = (create.jsonBody as { id: string }).id;
    const r = await invoke(router, 'patch', '/:id/archive', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id },
      }),
    });
    expect(r.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(requestTemplates)
      .where(eq(requestTemplates.id, id));
    expect(row!.status).toBe('ARCHIVED');
  });
});
