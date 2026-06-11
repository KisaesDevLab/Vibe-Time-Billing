// SPDX-License-Identifier: Elastic-2.0
//
// P25 — Renewal engine route tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { engagements, renewals } from '@vibe/db/schema';
import { createRenewalRouter } from '../renewals/routes';

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
  router: ReturnType<typeof createRenewalRouter>,
  method: 'get' | 'post',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const route = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return route.path === path && route.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method.toUpperCase()} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

async function setup(opts: { endDateDaysOut?: number } = {}): Promise<{
  firmId: string;
  appUserId: string;
  engagementId: string;
  router: ReturnType<typeof createRenewalRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const days = opts.endDateDaysOut ?? 60;
  const endDate = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  await harness.db
    .update(engagements)
    .set({ endDate, feeAmountCents: 100_000, status: 'ACTIVE' })
    .where(eq(engagements.id, seed.engagementId));
  const router = createRenewalRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    cpiSnapshot: {
      series: 'CUUR0000SA0',
      currentValue: 309.685,
      currentPeriod: '2026-04',
      priorValue: 300.665,
      priorPeriod: '2025-04',
      fetchedAt: new Date().toISOString(),
    },
  });
  return {
    firmId: seed.firmId,
    appUserId: seed.appUserId,
    engagementId: seed.engagementId,
    router,
  };
}

describe('P25 — scan', () => {
  it('creates a CANDIDATE row for an engagement ending within 90 days', async () => {
    const f = await setup({ endDateDaysOut: 60 });
    const r = await invoke(f.router, 'post', '/scan', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {},
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { eligible: number; inserted: number };
    expect(body.eligible).toBe(1);
    expect(body.inserted).toBe(1);
    const rows = await harness.db.select().from(renewals);
    expect(rows.length).toBe(1);
    expect(rows[0]!.currentEngagementId).toBe(f.engagementId);
    expect(rows[0]!.state).toBe('CANDIDATE');
  });

  it('skips engagement ending outside the window', async () => {
    const f = await setup({ endDateDaysOut: 200 });
    const r = await invoke(f.router, 'post', '/scan', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {},
    });
    expect((r.jsonBody as { eligible: number }).eligible).toBe(0);
  });

  it('is idempotent — second scan inserts zero', async () => {
    const f = await setup();
    await invoke(f.router, 'post', '/scan', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {},
    });
    const second = await invoke(f.router, 'post', '/scan', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {},
    });
    expect((second.jsonBody as { inserted: number }).inserted).toBe(0);
  });
});

describe('P25 — uplift', () => {
  async function seedCandidate(f: Awaited<ReturnType<typeof setup>>): Promise<string> {
    await invoke(f.router, 'post', '/scan', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {},
    });
    const [row] = await harness.db.select().from(renewals);
    return row!.id;
  }

  it('MANUAL_PERCENT writes uplift_bps + suggested_total', async () => {
    const f = await setup();
    const id = await seedCandidate(f);
    const r = await invoke(f.router, 'post', '/:id/uplift', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id },
        body: { mode: 'MANUAL_PERCENT', manualBps: 500 },
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { upliftBps: number; suggestedTotalCents: number };
    expect(body.upliftBps).toBe(500);
    expect(body.suggestedTotalCents).toBe(105_000);
    const [row] = await harness.db.select().from(renewals).where(eq(renewals.id, id));
    expect(row!.upliftMode).toBe('MANUAL_PERCENT');
    expect(row!.upliftBps).toBe(500);
    expect(Number(row!.suggestedTotalCents)).toBe(105_000);
  });

  it('REALIZATION_BASED computes from prior billed/billable', async () => {
    const f = await setup();
    const id = await seedCandidate(f);
    const r = await invoke(f.router, 'post', '/:id/uplift', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id },
        body: {
          mode: 'REALIZATION_BASED',
          priorBilledCents: 80_000,
          priorBillableCents: 100_000,
        },
      }),
    });
    expect((r.jsonBody as { upliftBps: number }).upliftBps).toBe(2_500);
  });

  it('CPI_INDEXED uses the wired snapshot', async () => {
    const f = await setup();
    const id = await seedCandidate(f);
    const r = await invoke(f.router, 'post', '/:id/uplift', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id },
        body: { mode: 'CPI_INDEXED' },
      }),
    });
    const body = r.jsonBody as { upliftBps: number };
    expect(body.upliftBps).toBeGreaterThan(290);
    expect(body.upliftBps).toBeLessThan(310);
    const [row] = await harness.db.select().from(renewals).where(eq(renewals.id, id));
    expect(row!.cpiSnapshot).not.toBeNull();
  });

  it('rejects uplift on non-CANDIDATE state', async () => {
    const f = await setup();
    const id = await seedCandidate(f);
    await harness.db.update(renewals).set({ state: 'PROPOSED' }).where(eq(renewals.id, id));
    const r = await invoke(f.router, 'post', '/:id/uplift', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id },
        body: { mode: 'MANUAL_PERCENT', manualBps: 500 },
      }),
    });
    expect(r.statusCode).toBe(409);
  });
});

describe('P25 — auto-renew toggle', () => {
  it('flips auto_renew flag', async () => {
    const f = await setup();
    await invoke(f.router, 'post', '/scan', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
      body: {},
    });
    const [row] = await harness.db.select().from(renewals);
    const r = await invoke(f.router, 'post', '/:id/auto-renew', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { id: row!.id },
        body: { autoRenew: true },
      }),
    });
    expect(r.statusCode).toBe(200);
    const [after] = await harness.db.select().from(renewals).where(eq(renewals.id, row!.id));
    expect(after!.autoRenew).toBe(true);
  });
});
