// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0086 — multi-engagement billing batches. The single billing-batch
// POST now accepts engagementIds[]; the join table holds the full set;
// invoice generation produces a consolidated invoice with one
// TIME_AGGREGATE line per engagement and primary_engagement_id NULL.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type express from 'express';

import {
  billingBatchEngagements,
  billingBatchEntries,
  billingBatches,
  invoiceLineItems,
  invoices,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createBillingBatchRouter } from '../billing-batches/routes';
import { createInvoiceRouter } from '../invoices/routes';

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

/**
 * Seed a second engagement under the same client and a rate code + work
 * code so we can insert time entries on both engagements.
 */
async function seedSecondEngagement(
  db: PgliteHarness['db'],
  clientId: string,
  name: string,
): Promise<string> {
  const row = await db.execute(
    sql`INSERT INTO engagement (client_id, name, fee_structure)
        VALUES (${clientId}, ${name}, 'HOURLY') RETURNING id`,
  );
  return (row as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

async function seedTimeEntry(
  db: PgliteHarness['db'],
  args: {
    engagementId: string;
    appUserId: string;
    workCodeId: string;
    entryDate: string;
    hours: string;
    standardAmountCents: number;
  },
): Promise<string> {
  const ratePerHour = Math.round(args.standardAmountCents / Number(args.hours));
  const r = await db.execute(
    sql`INSERT INTO time_entry
          (engagement_id, app_user_id, work_code_id, entry_date, hours,
           standard_rate_snapshot_cents, standard_amount_cents,
           in_scope_flag, description, status)
        VALUES (${args.engagementId}, ${args.appUserId}, ${args.workCodeId},
                ${args.entryDate}, ${args.hours}, ${ratePerHour},
                ${args.standardAmountCents}, false, 'work', 'SUBMITTED')
        RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

describe('billing-batch multi-engagement', () => {
  it('POST / with engagementIds creates batch + N join rows + aggregates WIP across all', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const eng2Id = await seedSecondEngagement(harness.db, seed.clientId, 'Bookkeeping 2026');
    await seedTimeEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      entryDate: '2026-04-15',
      hours: '4.00',
      standardAmountCents: 80000, // $800
    });
    await seedTimeEntry(harness.db, {
      engagementId: eng2Id,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      entryDate: '2026-04-20',
      hours: '2.00',
      standardAmountCents: 40000, // $400
    });

    const router = createBillingBatchRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          engagementIds: [seed.engagementId, eng2Id],
          periodStart: '2026-04-01',
          periodEnd: '2026-04-30',
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const batchId = (r.jsonBody as { id: string }).id;

    // Primary pointer is the first id (backward compat for legacy
    // readers).
    const [batchRow] = await harness.db
      .select()
      .from(billingBatches)
      .where(eq(billingBatches.id, batchId));
    expect(batchRow!.engagementId).toBe(seed.engagementId);

    // Join table has both rows in pick order.
    const links = await harness.db
      .select()
      .from(billingBatchEngagements)
      .where(eq(billingBatchEngagements.billingBatchId, batchId));
    expect(links.map((l) => l.engagementId).sort()).toEqual([seed.engagementId, eng2Id].sort());
    expect(links.find((l) => l.engagementId === seed.engagementId)!.ordinal).toBe(0);
    expect(links.find((l) => l.engagementId === eng2Id)!.ordinal).toBe(1);

    // Time entries on BOTH engagements were attached to the batch.
    const entries = await harness.db
      .select()
      .from(billingBatchEntries)
      .where(eq(billingBatchEntries.billingBatchId, batchId));
    expect(entries).toHaveLength(2);
  });

  it('rejects engagements that belong to different clients with mixed_clients', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // Second client + engagement under the same firm. 0092 made
    // client.office_id NOT NULL, so attach a firm office.
    const office = await harness.db.execute(
      sql`INSERT INTO office (firm_id, name, timezone, is_default)
          VALUES (${seed.firmId}, 'Branch', 'America/Chicago', false) RETURNING id`,
    );
    const officeId = (office as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${seed.firmId}, 'OtherCo', ${seed.appUserId}, ${officeId}) RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherEngId = await seedSecondEngagement(harness.db, otherClientId, 'Other');
    const router = createBillingBatchRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          engagementIds: [seed.engagementId, otherEngId],
          periodStart: '2026-04-01',
          periodEnd: '2026-04-30',
        },
      }),
    });
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('mixed_clients');
  });

  it('legacy single engagementId payload still works (backward compat)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createBillingBatchRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          engagementId: seed.engagementId,
          periodStart: '2026-04-01',
          periodEnd: '2026-04-30',
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const batchId = (r.jsonBody as { id: string }).id;
    const links = await harness.db
      .select()
      .from(billingBatchEngagements)
      .where(eq(billingBatchEngagements.billingBatchId, batchId));
    expect(links).toHaveLength(1);
    expect(links[0]!.engagementId).toBe(seed.engagementId);
  });

  it('retainer batch with multiple engagements is rejected', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const eng2Id = await seedSecondEngagement(harness.db, seed.clientId, 'Eng 2');
    const router = createBillingBatchRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          engagementIds: [seed.engagementId, eng2Id],
          periodStart: '2026-04-01',
          periodEnd: '2026-04-30',
          kind: 'RETAINER',
          retainerTargetAmountCents: 100000,
        },
      }),
    });
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('retainer_batch_single_engagement_only');
  });

  it('cross-firm engagement is rejected with client_not_found', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // Other firm's engagement.
    const otherFirm = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other Firm') RETURNING id`,
    );
    const otherFirmId = (otherFirm as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@x.example', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherOffice = await harness.db.execute(
      sql`INSERT INTO office (firm_id, name, timezone, is_default)
          VALUES (${otherFirmId}, 'HQ', 'America/Chicago', true) RETURNING id`,
    );
    const otherOfficeId = (otherOffice as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${otherFirmId}, 'OtherCo', ${otherUserId}, ${otherOfficeId}) RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherEngId = await seedSecondEngagement(harness.db, otherClientId, 'Cross');
    const router = createBillingBatchRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          engagementIds: [otherEngId],
          periodStart: '2026-04-01',
          periodEnd: '2026-04-30',
        },
      }),
    });
    expect(r.statusCode).toBe(404);
  });

  it('GET / returns engagements[] alongside the legacy engagementName', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const eng2Id = await seedSecondEngagement(harness.db, seed.clientId, 'Eng 2');
    const router = createBillingBatchRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    await invoke(router, 'post', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          engagementIds: [seed.engagementId, eng2Id],
          periodStart: '2026-04-01',
          periodEnd: '2026-04-30',
        },
      }),
    });
    const list = await invoke(router, 'get', '/', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
    });
    expect(list.statusCode).toBe(200);
    const items = (list.jsonBody as { items: Array<{ engagements: Array<{ id: string }> }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.engagements.map((e) => e.id).sort()).toEqual(
      [seed.engagementId, eng2Id].sort(),
    );
  });

  it('GET /:id surfaces the firm retainer default-biller-toggle (R2)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createBillingBatchRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const created = await invoke(router, 'post', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          engagementId: seed.engagementId,
          periodStart: '2026-04-01',
          periodEnd: '2026-04-30',
        },
      }),
    });
    const batchId = (created.jsonBody as { id: string }).id;

    // No firm_retainer_settings row yet → schema defaults (feature off,
    // toggle on).
    const before = await invoke(router, 'get', '/:id', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId, params: { id: batchId } }),
    });
    expect(before.statusCode).toBe(200);
    expect((before.jsonBody as { retainer: { defaultBillerToggleOn: boolean } }).retainer).toEqual({
      featureEnabled: false,
      defaultBillerToggleOn: true,
    });

    // Firm turns the feature on but sets the biller toggle to default OFF.
    await harness.db.execute(
      sql`INSERT INTO firm_retainer_settings (firm_id, feature_enabled, default_biller_toggle_on)
          VALUES (${seed.firmId}, true, false)`,
    );
    const after = await invoke(router, 'get', '/:id', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId, params: { id: batchId } }),
    });
    expect((after.jsonBody as { retainer: { defaultBillerToggleOn: boolean } }).retainer).toEqual({
      featureEnabled: true,
      defaultBillerToggleOn: false,
    });
  });

  it('generate-from-batch produces a consolidated invoice with per-line engagement_id and NULL primary', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const eng2Id = await seedSecondEngagement(harness.db, seed.clientId, 'Eng 2');
    // WIP on each engagement.
    await seedTimeEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      entryDate: '2026-04-15',
      hours: '4.00',
      standardAmountCents: 80000,
    });
    await seedTimeEntry(harness.db, {
      engagementId: eng2Id,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      entryDate: '2026-04-20',
      hours: '2.00',
      standardAmountCents: 40000,
    });

    // Create a multi-engagement batch + finalize it.
    const batchRouter = createBillingBatchRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const created = await invoke(batchRouter, 'post', '/', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          engagementIds: [seed.engagementId, eng2Id],
          periodStart: '2026-04-01',
          periodEnd: '2026-04-30',
        },
      }),
    });
    const batchId = (created.jsonBody as { id: string }).id;
    // Flip status to APPROVED so the invoice endpoint accepts it.
    await harness.db
      .update(billingBatches)
      .set({ status: 'APPROVED' })
      .where(eq(billingBatches.id, batchId));

    const invoiceRouter = createInvoiceRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(invoiceRouter, 'post', '/generate-from-batch', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: { billingBatchId: batchId },
      }),
    });
    expect(r.statusCode).toBe(201);
    const invoiceId = (r.jsonBody as { id: string }).id;
    const [inv] = await harness.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv!.primaryEngagementId).toBeNull(); // consolidated → NULL
    const lines = await harness.db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));
    // One TIME_AGGREGATE line per engagement.
    expect(lines.filter((l) => l.kind === 'TIME_AGGREGATE')).toHaveLength(2);
    const taggedEngIds = new Set(
      lines.filter((l) => l.kind === 'TIME_AGGREGATE').map((l) => l.engagementId),
    );
    expect(taggedEngIds.has(seed.engagementId)).toBe(true);
    expect(taggedEngIds.has(eng2Id)).toBe(true);
    // No surcharge / tax on consolidated invoices.
    expect(lines.find((l) => l.kind === 'SURCHARGE')).toBeUndefined();
    expect(lines.find((l) => l.kind === 'SALES_TAX')).toBeUndefined();
    // Total = $800 + $400 = $1200 ($120000c)
    expect(inv!.subtotalCents).toBe(120000);
  });
});
