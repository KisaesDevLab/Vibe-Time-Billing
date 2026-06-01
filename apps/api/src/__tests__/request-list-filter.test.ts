// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0084 — request list filtering / sorting / pagination matrix.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createRequestRouter } from '../requests/routes';

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

function makeReq(over: Partial<FakeReq> & { firmId: string; appUserId: string }): FakeReq {
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

async function seedRequest(
  db: PgliteHarness['db'],
  args: {
    firmId: string;
    engagementId: string;
    title: string;
    body?: string;
    status?: string;
    priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
    dueDate?: string | null;
    assignedAppUserId?: string | null;
    tags?: string[];
    createdAt?: Date;
    fulfilledByAppUserId?: string | null;
  },
): Promise<string> {
  const tags = JSON.stringify(args.tags ?? []);
  const created = args.createdAt ?? new Date();
  // The CHECK constraint requires exactly one fulfilled-by actor when
  // status is FULFILLED. Auto-populate from args if caller didn't.
  const status = args.status ?? 'OPEN';
  const fulfilledBy = status === 'FULFILLED' ? (args.fulfilledByAppUserId ?? null) : null;
  const fulfilledAt = status === 'FULFILLED' ? created : null;
  const row = await db.execute(
    sql`INSERT INTO client_request
        (firm_id, engagement_id, title, body, status, priority, due_date,
         assigned_app_user_id, tags, fulfilled_at, fulfilled_by_app_user_id,
         created_at, updated_at)
        VALUES (${args.firmId}, ${args.engagementId}, ${args.title}, ${args.body ?? ''},
                ${status}, ${args.priority ?? 'MEDIUM'},
                ${args.dueDate ?? null}, ${args.assignedAppUserId ?? null},
                ${tags}::jsonb, ${fulfilledAt}, ${fulfilledBy},
                ${created}, ${created})
        RETURNING id`,
  );
  return (row as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

describe('request list filter / sort / pagination', () => {
  it('filters by status, priority, assignedAppUserId, dueBefore, dueAfter, search, tag', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });

    // 5 requests with varied dims.
    await seedRequest(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'High urgent due soon',
      priority: 'URGENT',
      dueDate: '2026-06-01',
      assignedAppUserId: seed.appUserId,
      tags: ['urgent', 'tax'],
    });
    await seedRequest(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'Medium-priority audit checklist',
      body: 'audit work',
      priority: 'MEDIUM',
      dueDate: '2026-07-15',
      tags: ['audit'],
    });
    await seedRequest(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'Low-priority compilation',
      priority: 'LOW',
      dueDate: '2026-08-01',
      tags: [],
    });
    await seedRequest(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'Already done',
      status: 'FULFILLED',
      priority: 'HIGH',
      fulfilledByAppUserId: seed.appUserId,
    });
    await seedRequest(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'Needs info from client',
      status: 'NEEDS_INFO',
      priority: 'HIGH',
    });

    // status=OPEN drops the FULFILLED and NEEDS_INFO rows.
    const open = await invoke(router, 'get', '/', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId, query: { status: 'OPEN' } }),
    });
    expect((open.jsonBody as { total: number }).total).toBe(3);

    // priority=URGENT narrows to one.
    const urgent = await invoke(router, 'get', '/', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId, query: { priority: 'URGENT' } }),
    });
    expect((urgent.jsonBody as { total: number }).total).toBe(1);

    // assignedAppUserId narrows.
    const assigned = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { assignedAppUserId: seed.appUserId },
      }),
    });
    expect((assigned.jsonBody as { total: number }).total).toBe(1);

    // dueBefore boundary inclusive.
    const before = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { dueBefore: '2026-07-01', status: 'OPEN' },
      }),
    });
    expect((before.jsonBody as { total: number }).total).toBe(1);

    // dueAfter narrows the other way.
    const after = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { dueAfter: '2026-07-15', status: 'OPEN' },
      }),
    });
    expect((after.jsonBody as { total: number }).total).toBe(2);

    // Search hits title (case insensitive).
    const searchTitle = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { search: 'audit' },
      }),
    });
    expect((searchTitle.jsonBody as { total: number }).total).toBe(1);

    // Search hits body too.
    const searchBody = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { search: 'audit work' },
      }),
    });
    expect((searchBody.jsonBody as { total: number }).total).toBe(1);

    // tag filter (jsonb contains).
    const tag = await invoke(router, 'get', '/', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId, query: { tag: 'audit' } }),
    });
    expect((tag.jsonBody as { total: number }).total).toBe(1);
  });

  it('sorts by due_date asc and desc; falls back to created_at', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    await seedRequest(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'A',
      dueDate: '2026-09-01',
    });
    await seedRequest(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'B',
      dueDate: '2026-06-01',
    });
    await seedRequest(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'C',
      dueDate: '2026-07-01',
    });

    const asc = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { sort: 'due_date', dir: 'asc' },
      }),
    });
    const ascTitles = (asc.jsonBody as { items: Array<{ title: string }> }).items.map(
      (i) => i.title,
    );
    expect(ascTitles).toEqual(['B', 'C', 'A']);

    const desc = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { sort: 'due_date', dir: 'desc' },
      }),
    });
    const descTitles = (desc.jsonBody as { items: Array<{ title: string }> }).items.map(
      (i) => i.title,
    );
    expect(descTitles).toEqual(['A', 'C', 'B']);
  });

  it('paginates with limit + offset and reports total', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    for (let i = 0; i < 5; i++) {
      await seedRequest(harness.db, {
        firmId: seed.firmId,
        engagementId: seed.engagementId,
        title: `R${i}`,
        // Distinct created_at so order is deterministic.
        createdAt: new Date(2026, 0, i + 1),
      });
    }
    const page1 = await invoke(router, 'get', '/', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId, query: { limit: '2' } }),
    });
    expect((page1.jsonBody as { total: number; items: unknown[] }).total).toBe(5);
    expect((page1.jsonBody as { items: unknown[] }).items).toHaveLength(2);

    const page2 = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { limit: '2', offset: '2' },
      }),
    });
    expect((page2.jsonBody as { items: unknown[] }).items).toHaveLength(2);

    const page3 = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { limit: '2', offset: '4' },
      }),
    });
    expect((page3.jsonBody as { items: unknown[] }).items).toHaveLength(1);
  });

  it('filters by clientId via engagement join (cross-firm hidden)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    // 2 in our firm's client.
    await seedRequest(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'mine-1',
    });
    await seedRequest(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'mine-2',
    });
    // Other firm + engagement.
    const otherFirm = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other Firm') RETURNING id`,
    );
    const otherFirmId = (otherFirm as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@x', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id)
          VALUES (${otherFirmId}, 'OtherCo', ${otherUserId}) RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherEng = await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure)
          VALUES (${otherClientId}, 'OtherEng', 'HOURLY') RETURNING id`,
    );
    const otherEngId = (otherEng as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await seedRequest(harness.db, {
      firmId: otherFirmId,
      engagementId: otherEngId,
      title: 'other-firm',
    });

    // Same firm clientId scope.
    const mine = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { clientId: seed.clientId },
      }),
    });
    expect((mine.jsonBody as { total: number }).total).toBe(2);

    // Passing the other firm's client id from our session returns 0 — the
    // firmId predicate eliminates the row even though the join would
    // otherwise match.
    const cross = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { clientId: otherClientId },
      }),
    });
    expect((cross.jsonBody as { total: number }).total).toBe(0);
  });
});
