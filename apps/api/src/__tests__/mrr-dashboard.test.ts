// SPDX-License-Identifier: Elastic-2.0
//
// P29 — MRR dashboard route tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createMrrDashboardRouter } from '../dashboards/mrr-routes';

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
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  get(_h: string): string | undefined;
}
interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeReq(o: { firmId: string; appUserId: string } & Partial<FakeReq>): FakeReq {
  return {
    body: o.body ?? {},
    params: o.params ?? {},
    query: o.query ?? {},
    staffSession: { firmId: o.firmId, appUserId: o.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}
function makeRes(): FakeRes {
  const r: FakeRes = {
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
  return r;
}
async function invoke(
  router: ReturnType<typeof createMrrDashboardRouter>,
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
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

async function seedActivePlan(): Promise<{
  firmId: string;
  appUserId: string;
  engagementId: string;
  router: ReturnType<typeof createMrrDashboardRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  await harness.db.execute(
    sql`UPDATE engagement SET status = 'ACTIVE',
            fee_structure = 'RECURRING_SUBSCRIPTION',
            fee_amount_cents = 100000
            WHERE id = ${seed.engagementId}`,
  );
  await harness.db.execute(
    sql`INSERT INTO recurring_billing_plan
          (engagement_id, frequency, amount_cents, next_run_date, status)
        VALUES
          (${seed.engagementId}, 'MONTHLY', 100000, '2026-06-01', 'ACTIVE')`,
  );
  const router = createMrrDashboardRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  return {
    firmId: seed.firmId,
    appUserId: seed.appUserId,
    engagementId: seed.engagementId,
    router,
  };
}

describe('P29 — GET /dashboards/mrr', () => {
  it('returns current MRR from active plan', async () => {
    const f = await seedActivePlan();
    const r = await invoke(f.router, '/mrr', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      currentMrrCents: number;
      monthOverMonthDeltaCents: number | null;
      cashFlow: { windowDays: number; expectedCents: number }[];
      mandateHealth: { invalid: number };
      annualForecastCents: number;
    };
    expect(body.currentMrrCents).toBe(100_000);
    expect(body.monthOverMonthDeltaCents).toBeNull();
    expect(body.cashFlow.length).toBe(3);
    expect(body.mandateHealth.invalid).toBe(0);
    expect(body.annualForecastCents).toBe(100_000 * 12);
  });

  it('counts invalid mandates', async () => {
    const f = await seedActivePlan();
    await harness.db.execute(
      sql`INSERT INTO payment_mandates
            (firm_id, client_id, kind, stripe_account_id, stripe_customer_id,
             stripe_payment_method_id, stripe_mandate_id, mandate_text_rendered,
             mandate_text_hash, state)
          VALUES (${f.firmId}, (SELECT id FROM client LIMIT 1), 'ACH',
                  'acct_1', 'cus_1', 'pm_1', 'mandate_1',
                  'text', repeat('a', 64), 'INVALID'),
                 (${f.firmId}, (SELECT id FROM client LIMIT 1), 'ACH',
                  'acct_1', 'cus_2', 'pm_2', 'mandate_2',
                  'text', repeat('b', 64), 'ACTIVE')`,
    );
    const r = await invoke(f.router, '/mrr', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    const body = r.jsonBody as { mandateHealth: { invalid: number; active: number } };
    expect(body.mandateHealth.invalid).toBe(1);
    expect(body.mandateHealth.active).toBe(1);
  });

  it('includes overdue invoices in failedInvoices', async () => {
    const f = await seedActivePlan();
    await harness.db.execute(
      sql`INSERT INTO invoice
            (firm_id, client_id, primary_engagement_id, invoice_number,
             issue_date, due_date, subtotal_cents, total_cents, status)
          VALUES (${f.firmId}, (SELECT id FROM client LIMIT 1), ${f.engagementId},
                  'INV-1', '2026-04-01', '2026-04-30', 50000, 50000, 'OVERDUE')`,
    );
    const r = await invoke(f.router, '/mrr', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    const body = r.jsonBody as { failedInvoices: { id: string; daysOverdue: number }[] };
    expect(body.failedInvoices.length).toBe(1);
    expect(body.failedInvoices[0]!.daysOverdue).toBeGreaterThan(20);
  });

  it('returns 0 MRR when no plans exist', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createMrrDashboardRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, '/mrr', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { currentMrrCents: number };
    expect(body.currentMrrCents).toBe(0);
  });
});
