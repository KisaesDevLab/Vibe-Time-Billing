// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// The invoices list returns the distinct engagement type names billed on
// each invoice (aggregated across its line items' engagements). Drives the
// "Engagement type" column on the client Billing tab.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type express from 'express';

import type { RoleSlug } from '@vibe/core/rbac';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createInvoiceRouter } from '../invoices/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
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
async function invokeGet(
  router: express.Router,
  query: Record<string, string>,
  firmId: string,
  appUserId: string,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === '/' && r.methods['get'] === true;
  });
  if (!layer) throw new Error('GET / not registered');
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  const req = {
    body: {},
    params: {},
    query,
    headers: {},
    staffSession: { firmId, appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

async function scalarId(db: PgliteHarness['db'], q: ReturnType<typeof sql>): Promise<string> {
  const r = await db.execute(q);
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

describe('invoices list — engagement types billed', () => {
  it('aggregates distinct engagement type names across line items', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const db = harness.db;

    // Two engagement types; two engagements (seed's + a new one) typed.
    const taxTypeId = await scalarId(
      db,
      sql`INSERT INTO engagement_type (firm_id, key, name)
          VALUES (${seed.firmId}, '1040', 'Individual 1040') RETURNING id`,
    );
    const bkTypeId = await scalarId(
      db,
      sql`INSERT INTO engagement_type (firm_id, key, name)
          VALUES (${seed.firmId}, 'bk', 'Bookkeeping') RETURNING id`,
    );
    await db.execute(
      sql`UPDATE engagement SET engagement_type_id = ${taxTypeId} WHERE id = ${seed.engagementId}`,
    );
    const eng2 = await scalarId(
      db,
      sql`INSERT INTO engagement (client_id, name, fee_structure, engagement_type_id)
          VALUES (${seed.clientId}, 'Bookkeeping 2026', 'HOURLY', ${bkTypeId}) RETURNING id`,
    );

    // One invoice with line items on both engagements.
    const invId = await scalarId(
      db,
      sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                               issue_date, due_date, subtotal_cents, total_cents, status)
          VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, 'INV-T1',
                  '2026-04-15', '2026-05-15', 100000, 100000, 'SENT') RETURNING id`,
    );
    await db.execute(
      sql`INSERT INTO invoice_line_item (invoice_id, engagement_id, kind, description, amount_cents, sort_order)
          VALUES (${invId}, ${seed.engagementId}, 'TIME_AGGREGATE', 'tax work', 60000, 0),
                 (${invId}, ${eng2}, 'TIME_AGGREGATE', 'bookkeeping', 40000, 1)`,
    );

    const router = createInvoiceRouter({
      db,
      fakeUserRoles: new Map<string, RoleSlug[]>([[seed.appUserId, ['partner']]]),
    });
    const res = await invokeGet(router, { clientId: seed.clientId }, seed.firmId, seed.appUserId);
    expect(res.statusCode).toBe(200);
    const items = (res.jsonBody as { items: Array<{ id: string; engagementTypes: string | null }> })
      .items;
    const row = items.find((i) => i.id === invId);
    expect(row).toBeTruthy();
    // Distinct, comma-joined (order is alphabetical via string_agg DISTINCT).
    expect(row!.engagementTypes).toBe('Bookkeeping, Individual 1040');
  });

  it('is null when no line item is tied to a typed engagement', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const db = harness.db;
    const invId = await scalarId(
      db,
      sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                               issue_date, due_date, subtotal_cents, total_cents, status)
          VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, 'INV-T2',
                  '2026-04-15', '2026-05-15', 50000, 50000, 'SENT') RETURNING id`,
    );
    await db.execute(
      sql`INSERT INTO invoice_line_item (invoice_id, kind, description, amount_cents, sort_order)
          VALUES (${invId}, 'TIME_AGGREGATE', 'misc', 50000, 0)`,
    );
    const router = createInvoiceRouter({
      db,
      fakeUserRoles: new Map<string, RoleSlug[]>([[seed.appUserId, ['partner']]]),
    });
    const res = await invokeGet(router, { clientId: seed.clientId }, seed.firmId, seed.appUserId);
    const items = (res.jsonBody as { items: Array<{ id: string; engagementTypes: string | null }> })
      .items;
    expect(items.find((i) => i.id === invId)!.engagementTypes).toBeNull();
  });
});
