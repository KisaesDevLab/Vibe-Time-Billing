// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Reports / MRR — regression for the recurring-frequency normalization.
// The monthly() switch was missing a SEMIANNUAL case, so a plan billed every
// 6 months fell through `default: return amount` and was counted as a full
// MONTHLY charge — overstating its MRR contribution 6×.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createReportRouter } from '../reports/routes';

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
async function invoke(
  router: express.Router,
  path: string,
  firmId: string,
  appUserId: string,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods['get'] === true;
  });
  if (!layer) throw new Error(`route not registered: GET ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(
    {
      query: {},
      params: {},
      body: {},
      staffSession: { firmId, appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    },
    res,
  );
  return res;
}

describe('Reports — GET /mrr', () => {
  it('normalizes a SEMIANNUAL plan to 1/6 (not a full monthly charge)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // $6,000 billed every 6 months ⇒ $1,000/mo.
    await harness.db.execute(sql`
      INSERT INTO recurring_billing_plan (engagement_id, frequency, amount_cents, next_run_date, status)
      VALUES (${seed.engagementId}, 'SEMIANNUAL', 600000, '2026-07-01', 'ACTIVE')`);
    // A plain $500/mo plan to prove MONTHLY still works.
    await harness.db.execute(sql`
      INSERT INTO recurring_billing_plan (engagement_id, frequency, amount_cents, next_run_date, status)
      VALUES (${seed.engagementId}, 'MONTHLY', 50000, '2026-07-01', 'ACTIVE')`);

    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, '/mrr', seed.firmId, seed.appUserId);
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      mrrCents: number;
      arrCents: number;
      planCount: number;
      items: Array<{ frequency: string; monthlyAmountCents: number }>;
    };
    const semi = body.items.find((i) => i.frequency === 'SEMIANNUAL')!;
    expect(semi.monthlyAmountCents).toBe(100000); // 600000 / 6, not 600000
    // $1,000 + $500 = $1,500/mo; ARR = $18,000.
    expect(body.mrrCents).toBe(150000);
    expect(body.arrCents).toBe(1800000);
    expect(body.planCount).toBe(2);
  });
});
