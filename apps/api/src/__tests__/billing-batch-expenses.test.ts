// SPDX-License-Identifier: Elastic-2.0
//
// 0199 — engagement expenses in the billing batch. A batch claims unbilled
// expenses in its period, bills them at cost + markup, and applies the same
// INCLUDE/DEFER/WRITE_OFF actions as time. set-target carves the expense
// total out of the target FIRST; the remainder is written up/down across
// time only (expenses never touch per-timekeeper realization).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import type express from 'express';

import {
  adjustments,
  billingBatchEntries,
  billingBatchExpenses,
  billingBatches,
  engagementExpenses,
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

async function seedTimeEntry(
  db: PgliteHarness['db'],
  args: {
    engagementId: string;
    appUserId: string;
    workCodeId: string;
    standardAmountCents: number;
  },
): Promise<string> {
  const ratePerHour = Math.round(args.standardAmountCents / 4);
  const r = await db.execute(
    sql`INSERT INTO time_entry
          (engagement_id, app_user_id, work_code_id, entry_date, hours,
           standard_rate_snapshot_cents, standard_amount_cents, in_scope_flag,
           description, status)
        VALUES (${args.engagementId}, ${args.appUserId}, ${args.workCodeId},
                '2026-04-15', '4.00', ${ratePerHour}, ${args.standardAmountCents},
                false, 'work', 'SUBMITTED')
        RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

async function seedExpense(
  db: PgliteHarness['db'],
  args: { firmId: string; engagementId: string; costCents: number; date?: string },
): Promise<string> {
  const r = await db.execute(
    sql`INSERT INTO engagement_expense
          (firm_id, engagement_id, expense_date, description, cost_cents, status)
        VALUES (${args.firmId}, ${args.engagementId}, ${args.date ?? '2026-04-10'},
                'Filing fee', ${args.costCents}, 'ACTIVE')
        RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

function batchRouter(seed: Awaited<ReturnType<typeof seedMinimalFirm>>): express.Router {
  return createBillingBatchRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner', 'admin']]]),
  });
}

async function createBatch(
  router: express.Router,
  seed: Awaited<ReturnType<typeof seedMinimalFirm>>,
): Promise<string> {
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
  expect(created.statusCode).toBe(201);
  return (created.jsonBody as { id: string }).id;
}

describe('billing-batch expenses (0199)', () => {
  it('batch create claims the expense at cost + 15% and assigns billing_batch_id', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const expenseId = await seedExpense(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      costCents: 10000, // $100
    });
    const router = batchRouter(seed);
    const batchId = await createBatch(router, seed);

    const [bbe] = await harness.db
      .select()
      .from(billingBatchExpenses)
      .where(eq(billingBatchExpenses.billingBatchId, batchId));
    expect(bbe!.expenseId).toBe(expenseId);
    expect(bbe!.action).toBe('INCLUDE');
    expect(bbe!.billedAmountCents).toBe(11500); // 10000 * 1.15

    const [exp] = await harness.db
      .select()
      .from(engagementExpenses)
      .where(eq(engagementExpenses.id, expenseId));
    expect(exp!.billingBatchId).toBe(batchId);
  });

  it('GET /:id returns the expense with its billed amount', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedExpense(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      costCents: 10000,
    });
    const router = batchRouter(seed);
    const batchId = await createBatch(router, seed);
    const r = await invoke(router, 'get', '/:id', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId, params: { id: batchId } }),
    });
    const body = r.jsonBody as {
      expenses: { costCents: number; billedAmountCents: number; action: string }[];
    };
    expect(body.expenses).toHaveLength(1);
    expect(body.expenses[0]!.costCents).toBe(10000);
    expect(body.expenses[0]!.billedAmountCents).toBe(11500);
    expect(body.expenses[0]!.action).toBe('INCLUDE');
  });

  it('GET /:id returns per-entry cost of labor + the firm estimated labor %', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // 4h at $50/hr cost = $200 cost of labor, in the batch period.
    await harness.db.execute(
      sql`INSERT INTO time_entry
            (engagement_id, app_user_id, work_code_id, entry_date, hours,
             standard_rate_snapshot_cents, standard_amount_cents, cost_rate_snapshot_cents,
             in_scope_flag, description, status)
          VALUES (${seed.engagementId}, ${seed.appUserId}, ${seed.workCodeId}, '2026-04-15',
                  '4.00', 20000, 80000, 5000, false, 'work', 'SUBMITTED')`,
    );
    const router = batchRouter(seed);
    const batchId = await createBatch(router, seed);
    const r = await invoke(router, 'get', '/:id', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId, params: { id: batchId } }),
    });
    const body = r.jsonBody as {
      entries: { costOfLaborCents: number; action: string }[];
      estimatedLaborPct: number;
    };
    expect(body.estimatedLaborPct).toBe(40); // default when no firm_settings row
    const included = body.entries.find((e) => e.action === 'INCLUDE');
    expect(included?.costOfLaborCents).toBe(20000); // 4 * 5000
  });

  it('set-target carves expenses out first; the FEE delta targets time only', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedTimeEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      standardAmountCents: 80000, // $800 time
    });
    await seedExpense(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      costCents: 10000, // $100 cost → $115 billed at 15%
    });
    const router = batchRouter(seed);
    const batchId = await createBatch(router, seed);
    const rc = await harness.db.execute(
      sql`INSERT INTO reason_code (firm_id, category, label)
          VALUES (${seed.firmId}, 'WRITE_UP', 'Premium') RETURNING id`,
    );
    const reasonId = (rc as unknown as { rows: { id: string }[] }).rows[0]!.id;

    const r = await invoke(router, 'post', '/:id/set-target', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: batchId },
        body: { targetAmountCents: 100000, reasonCodeId: reasonId, expenseMarkupPct: 15 },
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { deltaCents: number; expenseBilledTotal: number };
    // target 100000 − expenses 11500 = time target 88500; − time std 80000 = +8500 write-up.
    expect(body.expenseBilledTotal).toBe(11500);
    expect(body.deltaCents).toBe(8500);

    // The created FEE adjustment carries the TIME delta, not target − time.
    const [adj] = await harness.db
      .select({ total: adjustments.totalAmountCents })
      .from(adjustments)
      .where(eq(adjustments.billingBatchId, batchId));
    expect(adj!.total).toBe(8500);
  });

  it('draft-saved DEFER action is persisted and excluded from set-target allocation', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const e1 = await seedTimeEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      standardAmountCents: 80000, // $800 — stays INCLUDE
    });
    const e2 = await seedTimeEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      standardAmountCents: 40000, // $400 — will be deferred
    });
    const router = batchRouter(seed);
    const batchId = await createBatch(router, seed);

    // Draft-save: defer the second entry WITHOUT finalizing.
    const save = await invoke(router, 'patch', '/:id/actions', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: batchId },
        body: { actions: [{ timeEntryId: e2, action: 'DEFER' }] },
      }),
    });
    expect(save.statusCode).toBe(200);

    // Persisted to billing_batch_entry (and NOT released — still in batch).
    const [bbe2] = await harness.db
      .select()
      .from(billingBatchEntries)
      .where(
        and(
          eq(billingBatchEntries.billingBatchId, batchId),
          eq(billingBatchEntries.timeEntryId, e2),
        ),
      );
    expect(bbe2!.action).toBe('DEFER');

    const rc = await harness.db.execute(
      sql`INSERT INTO reason_code (firm_id, category, label)
          VALUES (${seed.firmId}, 'WRITE_DOWN', 'Scope') RETURNING id`,
    );
    const reasonId = (rc as unknown as { rows: { id: string }[] }).rows[0]!.id;

    // Target $500 with only e1 ($800) as INCLUDE → delta = 500 − 800 = −300.
    const r = await invoke(router, 'post', '/:id/set-target', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: batchId },
        body: { targetAmountCents: 50000, reasonCodeId: reasonId },
      }),
    });
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { deltaCents: number }).deltaCents).toBe(-30000);
    void e1;

    // The DEFER selection survived the set-target operation.
    const [bbe2After] = await harness.db
      .select()
      .from(billingBatchEntries)
      .where(
        and(
          eq(billingBatchEntries.billingBatchId, batchId),
          eq(billingBatchEntries.timeEntryId, e2),
        ),
      );
    expect(bbe2After!.action).toBe('DEFER');
  });

  it('finalize DEFER releases the expense back to the pool', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const expenseId = await seedExpense(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      costCents: 10000,
    });
    // A time entry so the finalize `actions` array is non-empty (min 1).
    const timeEntryId = await seedTimeEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      standardAmountCents: 80000,
    });
    const router = batchRouter(seed);
    const batchId = await createBatch(router, seed);

    const r = await invoke(router, 'patch', '/:id/finalize', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: batchId },
        body: {
          actions: [{ timeEntryId, action: 'INCLUDE' }],
          expenseActions: [{ expenseId, action: 'DEFER' }],
        },
      }),
    });
    expect(r.statusCode).toBe(200);

    const [bbe] = await harness.db
      .select()
      .from(billingBatchExpenses)
      .where(
        and(
          eq(billingBatchExpenses.billingBatchId, batchId),
          eq(billingBatchExpenses.expenseId, expenseId),
        ),
      );
    expect(bbe!.action).toBe('DEFER');
    const [exp] = await harness.db
      .select()
      .from(engagementExpenses)
      .where(eq(engagementExpenses.id, expenseId));
    // Released → available for a future batch.
    expect(exp!.billingBatchId).toBeNull();
  });

  it('generate-from-batch appends an EXPENSE line; invoice total = time + expense', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedTimeEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      standardAmountCents: 80000,
    });
    await seedExpense(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      costCents: 10000,
    });
    const router = batchRouter(seed);
    const batchId = await createBatch(router, seed);
    await harness.db
      .update(billingBatches)
      .set({ status: 'APPROVED' })
      .where(eq(billingBatches.id, batchId));

    const invoiceRouter = createInvoiceRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const g = await invoke(invoiceRouter, 'post', '/generate-from-batch', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: { billingBatchId: batchId },
      }),
    });
    expect(g.statusCode).toBe(201);
    const invoiceId = (g.jsonBody as { id: string }).id;
    const lines = await harness.db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));
    const expenseLine = lines.find((l) => l.kind === 'EXPENSE');
    expect(expenseLine).toBeDefined();
    expect(expenseLine!.amountCents).toBe(11500);
    const [inv] = await harness.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    // Time $800 + expense $115 = $915.
    expect(inv!.subtotalCents).toBe(91500);
  });
});
