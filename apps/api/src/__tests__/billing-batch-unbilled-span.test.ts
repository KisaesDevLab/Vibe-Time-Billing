// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0233 — GET /unbilled-span reports the full date range of everything
// still unbilled on an engagement (time entries + expenses). The /time
// "Bill" CTA seeds the billing-batch period from it, so a short span
// silently leaves billable work out of the batch.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createBillingBatchRouter } from '../billing-batches/routes';

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

interface Span {
  entryCount: number;
  expenseCount: number;
  oldestDate: string | null;
  newestDate: string | null;
}

async function getSpan(
  router: express.Router,
  args: { firmId: string; appUserId: string; query: Record<string, string> },
): Promise<{ statusCode: number; span: Span | null; body: unknown }> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === '/unbilled-span' && r.methods['get'] === true;
  });
  if (!layer) throw new Error('route not registered: get /unbilled-span');
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(
    {
      body: {},
      params: {},
      query: args.query,
      headers: {},
      staffSession: { firmId: args.firmId, appUserId: args.appUserId },
      ip: '127.0.0.1',
      header: () => undefined,
      get: () => undefined,
    },
    res,
  );
  return {
    statusCode: res.statusCode,
    span: (res.jsonBody as { span: Span | null } | undefined)?.span ?? null,
    body: res.jsonBody,
  };
}

async function seedTimeEntry(
  db: PgliteHarness['db'],
  args: { engagementId: string; appUserId: string; workCodeId: string; entryDate: string },
): Promise<void> {
  await db.execute(
    sql`INSERT INTO time_entry
          (engagement_id, app_user_id, work_code_id, entry_date, hours,
           standard_rate_snapshot_cents, standard_amount_cents,
           in_scope_flag, description, status)
        VALUES (${args.engagementId}, ${args.appUserId}, ${args.workCodeId},
                ${args.entryDate}, '1.00', 20000, 20000, true, 'work', 'SUBMITTED')`,
  );
}

function makeRouter(seed: { appUserId: string }): express.Router {
  return createBillingBatchRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
}

describe('billing-batches unbilled-span', () => {
  it('spans the oldest and newest unbilled entry on the engagement', async () => {
    const seed = await seedMinimalFirm(harness.db);
    for (const entryDate of ['2026-01-09', '2026-03-31', '2026-02-14']) {
      await seedTimeEntry(harness.db, { ...seed, entryDate });
    }

    const r = await getSpan(makeRouter(seed), {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      query: { engagementId: seed.engagementId },
    });

    expect(r.statusCode).toBe(200);
    expect(r.span).toMatchObject({
      entryCount: 3,
      oldestDate: '2026-01-09',
      newestDate: '2026-03-31',
    });
  });

  it('ignores entries already claimed by a batch', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedTimeEntry(harness.db, { ...seed, entryDate: '2026-01-09' });
    await seedTimeEntry(harness.db, { ...seed, entryDate: '2026-05-01' });
    const batch = await harness.db.execute(
      sql`INSERT INTO billing_batch (engagement_id, period_start, period_end, created_by_id)
          VALUES (${seed.engagementId}, '2026-05-01', '2026-05-31', ${seed.appUserId})
          RETURNING id`,
    );
    const batchId = (batch as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`UPDATE time_entry SET billing_batch_id = ${batchId} WHERE entry_date = '2026-05-01'`,
    );

    const r = await getSpan(makeRouter(seed), {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      query: { engagementId: seed.engagementId },
    });

    expect(r.span).toMatchObject({
      entryCount: 1,
      oldestDate: '2026-01-09',
      newestDate: '2026-01-09',
    });
  });

  it('stretches the span to cover unbilled expenses outside the time range', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedTimeEntry(harness.db, { ...seed, entryDate: '2026-02-10' });
    await harness.db.execute(
      sql`INSERT INTO engagement_expense
            (firm_id, engagement_id, expense_date, description, cost_cents, created_by_id)
          VALUES (${seed.firmId}, ${seed.engagementId}, '2025-11-04', 'Filing fee', 5000,
                  ${seed.appUserId})`,
    );

    const r = await getSpan(makeRouter(seed), {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      query: { engagementId: seed.engagementId },
    });

    expect(r.span).toMatchObject({
      entryCount: 1,
      expenseCount: 1,
      oldestDate: '2025-11-04',
      newestDate: '2026-02-10',
    });
  });

  it('covers a CLOSED engagement (the WIP rollup skips non-ACTIVE ones)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.execute(
      sql`UPDATE engagement SET status = 'CLOSED' WHERE id = ${seed.engagementId}`,
    );
    await seedTimeEntry(harness.db, { ...seed, entryDate: '2026-01-20' });

    const r = await getSpan(makeRouter(seed), {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      query: { engagementId: seed.engagementId },
    });

    expect(r.span).toMatchObject({ entryCount: 1, oldestDate: '2026-01-20' });
  });

  it('never reaches across firms and rejects a call with no scope', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedTimeEntry(harness.db, { ...seed, entryDate: '2026-01-20' });
    const other = await seedMinimalFirm(harness.db);
    const router = makeRouter(seed);

    const crossFirm = await getSpan(router, {
      firmId: other.firmId,
      appUserId: seed.appUserId,
      query: { engagementId: seed.engagementId },
    });
    expect(crossFirm.span).toMatchObject({
      entryCount: 0,
      oldestDate: null,
      newestDate: null,
    });

    const unscoped = await getSpan(router, {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      query: {},
    });
    expect(unscoped.statusCode).toBe(400);
    expect(unscoped.body).toEqual({ error: 'client_or_engagement_required' });
  });
});
