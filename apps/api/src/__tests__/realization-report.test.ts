// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Regression: the realization rollup must join allocations → adjustments →
// billing_batches. A prior bug joined adjustment_allocations.adjustment_id
// directly to billing_batches.id, but that column is an adjustments.id (per
// the schema FK and both the demo seed and the live adjustment flow). The
// inner join therefore matched nothing and every realization report rendered
// empty on real/sample data. These tests seed one applied write-down and
// assert the rollup is non-empty and arithmetically correct.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createReportRouter } from '../reports/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

interface FakeReq {
  query: Record<string, string>;
  params: Record<string, string>;
  body: unknown;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  get(_h: string): string | undefined;
}
interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  body: string | undefined;
  headers: Record<string, string>;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  send(b: string): FakeRes;
  setHeader(k: string, v: string): void;
}
function makeReq(firmId: string, appUserId: string, query: Record<string, string>): FakeReq {
  return {
    query,
    params: {},
    body: {},
    staffSession: { firmId, appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}
function makeRes(): FakeRes {
  const r: FakeRes = {
    statusCode: 200,
    jsonBody: undefined,
    body: undefined,
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
      this.body = b;
      return this;
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
  };
  return r;
}
async function invoke(
  router: ReturnType<typeof createReportRouter>,
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const route = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return route.path === path && route.methods['get'] === true;
  });
  if (!layer) throw new Error(`route not registered: GET ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  // Last handler in the stack is the route handler (permission middleware skipped).
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

function rows<T = { id: string }>(r: unknown): T[] {
  return (r as { rows: T[] }).rows;
}

// Seed one APPROVED billing batch with a single $1,000 time entry and an
// APPLIED $400 write-down allocated to the seeded user.
async function seedRealization(): Promise<{ firmId: string; appUserId: string }> {
  const seed = await seedMinimalFirm(harness.db);
  const batch = await harness.db.execute(sql`
    INSERT INTO billing_batch (engagement_id, period_start, period_end, status, created_by_id, approved_by_id)
    VALUES (${seed.engagementId}, '2026-01-01', '2026-01-31', 'APPROVED', ${seed.appUserId}, ${seed.appUserId})
    RETURNING id`);
  const batchId = rows(batch)[0]!.id;
  const te = await harness.db.execute(sql`
    INSERT INTO time_entry (engagement_id, app_user_id, work_code_id, entry_date, hours,
      standard_rate_snapshot_cents, standard_amount_cents, billing_batch_id)
    VALUES (${seed.engagementId}, ${seed.appUserId}, ${seed.workCodeId}, '2026-01-15', 2.0,
      50000, 100000, ${batchId})
    RETURNING id`);
  const teId = rows(te)[0]!.id;
  const rc = await harness.db.execute(sql`
    INSERT INTO reason_code (firm_id, category, label)
    VALUES (${seed.firmId}, 'WRITE_DOWN', 'Scope creep') RETURNING id`);
  const reasonId = rows(rc)[0]!.id;
  const adj = await harness.db.execute(sql`
    INSERT INTO adjustment (billing_batch_id, method, allocation_method, total_amount_cents,
      reason_code_id, status, created_by_id)
    VALUES (${batchId}, 'TIME', 'HIERARCHICAL_CASCADE', -40000, ${reasonId}, 'APPLIED', ${seed.appUserId})
    RETURNING id`);
  const adjId = rows(adj)[0]!.id;
  await harness.db.execute(sql`
    INSERT INTO adjustment_allocation (adjustment_id, time_entry_id, app_user_id,
      original_value_cents, adjusted_value_cents, adjustment_amount_cents)
    VALUES (${adjId}, ${teId}, ${seed.appUserId}, 100000, 60000, -40000)`);
  return { firmId: seed.firmId, appUserId: seed.appUserId };
}

describe('GET /realization', () => {
  it('rolls up the firm summary from allocations joined through adjustments', async () => {
    const { firmId, appUserId } = await seedRealization();
    const router = createReportRouter({ db: harness.db });
    const res = await invoke(router, '/realization', makeReq(firmId, appUserId, {}));
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as {
      dimension: string;
      summary: { originalValueCents: number; adjustedValueCents: number; realizationPct: number };
    };
    expect(body.dimension).toBe('firm');
    // $1,000 original written down to $600 → 60% realization.
    expect(body.summary.originalValueCents).toBe(100000);
    expect(body.summary.adjustedValueCents).toBe(60000);
    expect(body.summary.realizationPct).toBeCloseTo(0.6);
  });

  it('returns per-timekeeper items (non-empty) for the timekeeper dimension', async () => {
    const { firmId, appUserId } = await seedRealization();
    const router = createReportRouter({ db: harness.db });
    const res = await invoke(
      router,
      '/realization',
      makeReq(firmId, appUserId, { dimension: 'timekeeper' }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as {
      items: { key: string; originalValueCents: number; adjustedValueCents: number }[];
    };
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.key).toBe(appUserId);
    expect(body.items[0]!.originalValueCents).toBe(100000);
    expect(body.items[0]!.adjustedValueCents).toBe(60000);
  });
});
