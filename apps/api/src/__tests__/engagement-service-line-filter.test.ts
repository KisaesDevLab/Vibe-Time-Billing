// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Service-line dimension on the engagements list: response enrichment,
// ?serviceLineId filter, ?serviceLineCategory filter, and NULL handling
// for engagements without an engagement_type assigned.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type express from 'express';

import { engagements } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createEngagementRouter } from '../engagements/routes';

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
  method: 'get' | 'post' | 'patch',
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

async function seedServiceLineAndType(
  db: PgliteHarness['db'],
  firmId: string,
  args: {
    lineName: string;
    category: 'tax' | 'audit' | 'advisory' | 'bookkeeping' | 'payroll';
    typeKey: string;
    typeName: string;
  },
): Promise<{ serviceLineId: string; engagementTypeId: string }> {
  const slRow = await db.execute(
    sql`INSERT INTO service_line (firm_id, name, category)
        VALUES (${firmId}, ${args.lineName}, ${args.category}) RETURNING id`,
  );
  const serviceLineId = (slRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const etRow = await db.execute(
    sql`INSERT INTO engagement_type (firm_id, service_line_id, key, name)
        VALUES (${firmId}, ${serviceLineId}, ${args.typeKey}, ${args.typeName}) RETURNING id`,
  );
  const engagementTypeId = (etRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return { serviceLineId, engagementTypeId };
}

describe('engagements list — service-line dimension', () => {
  it('returns serviceLineId/Name/Category on rows whose engagement_type is set', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const { serviceLineId, engagementTypeId } = await seedServiceLineAndType(
      harness.db,
      seed.firmId,
      { lineName: 'Tax Compliance', category: 'tax', typeKey: '1040', typeName: 'Individual 1040' },
    );
    await harness.db
      .update(engagements)
      .set({ engagementTypeId })
      .where(eq(engagements.id, seed.engagementId));

    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'get', '/', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
    });
    expect(r.statusCode).toBe(200);
    const items = (r.jsonBody as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.serviceLineId).toBe(serviceLineId);
    expect(items[0]!.serviceLineName).toBe('Tax Compliance');
    expect(items[0]!.serviceLineCategory).toBe('tax');
  });

  it('serviceLineId query param narrows to engagements whose type maps to that line', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const taxBits = await seedServiceLineAndType(harness.db, seed.firmId, {
      lineName: 'Tax',
      category: 'tax',
      typeKey: '1040',
      typeName: 'Individual 1040',
    });
    const auditBits = await seedServiceLineAndType(harness.db, seed.firmId, {
      lineName: 'Audit',
      category: 'audit',
      typeKey: 'audit',
      typeName: 'Audit',
    });
    // Seed engagement → tax. Second engagement under same client → audit.
    await harness.db
      .update(engagements)
      .set({ engagementTypeId: taxBits.engagementTypeId })
      .where(eq(engagements.id, seed.engagementId));
    const otherEng = await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure, engagement_type_id)
          VALUES (${seed.clientId}, 'Audit 2026', 'HOURLY', ${auditBits.engagementTypeId})
          RETURNING id`,
    );
    const otherEngId = (otherEng as unknown as { rows: { id: string }[] }).rows[0]!.id;

    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const tax = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { serviceLineId: taxBits.serviceLineId },
      }),
    });
    expect((tax.jsonBody as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([
      seed.engagementId,
    ]);

    const audit = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { serviceLineId: auditBits.serviceLineId },
      }),
    });
    expect((audit.jsonBody as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([
      otherEngId,
    ]);
  });

  it('serviceLineCategory query param narrows by the category enum', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const taxBits = await seedServiceLineAndType(harness.db, seed.firmId, {
      lineName: 'Tax',
      category: 'tax',
      typeKey: '1040',
      typeName: 'Individual 1040',
    });
    const bkBits = await seedServiceLineAndType(harness.db, seed.firmId, {
      lineName: 'Bookkeeping',
      category: 'bookkeeping',
      typeKey: 'mb',
      typeName: 'Monthly Bookkeeping',
    });
    await harness.db
      .update(engagements)
      .set({ engagementTypeId: taxBits.engagementTypeId })
      .where(eq(engagements.id, seed.engagementId));
    await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure, engagement_type_id)
          VALUES (${seed.clientId}, 'Monthly bookkeeping', 'HOURLY', ${bkBits.engagementTypeId})`,
    );

    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { serviceLineCategory: 'bookkeeping' },
      }),
    });
    const items = (r.jsonBody as { items: Array<{ serviceLineCategory: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.serviceLineCategory).toBe('bookkeeping');
  });

  it('engagement without an engagement_type returns NULL service-line fields and is excluded by the filter', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // Default seedMinimalFirm engagement has no engagement_type_id.
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    // Unfiltered: present with NULL fields.
    const all = await invoke(router, 'get', '/', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
    });
    const allItems = (all.jsonBody as { items: Array<Record<string, unknown>> }).items;
    expect(allItems).toHaveLength(1);
    expect(allItems[0]!.serviceLineId).toBeNull();
    expect(allItems[0]!.serviceLineCategory).toBeNull();

    // Filtered by any category: excluded.
    const filtered = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { serviceLineCategory: 'tax' },
      }),
    });
    expect((filtered.jsonBody as { items: unknown[] }).items).toHaveLength(0);
  });

  it('rejects invalid serviceLineId with 400', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { serviceLineId: 'not-a-uuid' },
      }),
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('engagements list — client filter (multi-select)', () => {
  async function addClientWithEngagement(
    db: PgliteHarness['db'],
    firmId: string,
    appUserId: string,
    name: string,
  ): Promise<{ clientId: string; engagementId: string }> {
    const c = await db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${firmId}, ${name}, ${appUserId},
                  (SELECT id FROM office WHERE firm_id = ${firmId} ORDER BY is_default DESC LIMIT 1))
          RETURNING id`,
    );
    const clientId = (c as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const e = await db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure)
          VALUES (${clientId}, ${`${name} work`}, 'HOURLY') RETURNING id`,
    );
    const engagementId = (e as unknown as { rows: { id: string }[] }).rows[0]!.id;
    return { clientId, engagementId };
  }

  it('a single clientId narrows to that client', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const other = await addClientWithEngagement(
      harness.db,
      seed.firmId,
      seed.appUserId,
      'Delta LLC',
    );
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { clientId: other.clientId },
      }),
    });
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([
      other.engagementId,
    ]);
  });

  it('comma-separated clientIds return the union (the bug fix)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const a = await addClientWithEngagement(harness.db, seed.firmId, seed.appUserId, 'Delta LLC');
    const b = await addClientWithEngagement(
      harness.db,
      seed.firmId,
      seed.appUserId,
      'Delta Medical',
    );
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { clientId: `${a.clientId},${b.clientId}` },
      }),
    });
    expect(r.statusCode).toBe(200);
    const ids = (r.jsonBody as { items: Array<{ id: string }> }).items.map((i) => i.id).sort();
    expect(ids).toEqual([a.engagementId, b.engagementId].sort());
  });

  it('a malformed id in the list → 400 invalid_client_id', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const a = await addClientWithEngagement(harness.db, seed.firmId, seed.appUserId, 'Delta LLC');
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'get', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        query: { clientId: `${a.clientId},not-a-uuid` },
      }),
    });
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('invalid_client_id');
  });
});
