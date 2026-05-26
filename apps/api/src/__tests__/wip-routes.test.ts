// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P23 — WIP rollup route tests. Uses pglite + direct-handler invocation
// (same pattern as renewals.test.ts).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createWipRouter } from '../wip/routes';

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
  body: string | undefined;
  headers: Record<string, string>;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  send(b: string): FakeRes;
  setHeader(k: string, v: string): void;
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
  router: ReturnType<typeof createWipRouter>,
  method: 'get',
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

async function seedEngagementWithEntries(opts: {
  feeStructure?: string;
  feeAmountCents?: number | null;
}): Promise<{
  firmId: string;
  appUserId: string;
  engagementId: string;
  workCodeId: string;
  router: ReturnType<typeof createWipRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  await harness.db.execute(
    sql`UPDATE engagement SET fee_structure = ${opts.feeStructure ?? 'FIXED_FEE'}::fee_structure,
            fee_amount_cents = ${opts.feeAmountCents ?? 100_000}
            WHERE id = ${seed.engagementId}`,
  );
  // Two time entries.
  await harness.db.execute(
    sql`INSERT INTO time_entry
          (engagement_id, app_user_id, work_code_id, entry_date, hours,
           billable_flag, in_scope_flag, out_of_scope_override, description,
           standard_rate_snapshot_cents, standard_amount_cents)
        VALUES
          (${seed.engagementId}, ${seed.appUserId}, ${seed.workCodeId},
           '2026-05-01', 2.0, true, true, false, '',
           20000, 40000)`,
  );
  await harness.db.execute(
    sql`INSERT INTO time_entry
          (engagement_id, app_user_id, work_code_id, entry_date, hours,
           billable_flag, in_scope_flag, out_of_scope_override, description,
           standard_rate_snapshot_cents, standard_amount_cents)
        VALUES
          (${seed.engagementId}, ${seed.appUserId}, ${seed.workCodeId},
           '2026-05-02', 3.0, false, true, false, '',
           20000, 60000)`,
  );
  const router = createWipRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  return { ...seed, router };
}

describe('P23 — GET /wip/:engagementId', () => {
  it('rolls up WIP and returns realization for a fixed-fee engagement', async () => {
    const f = await seedEngagementWithEntries({
      feeStructure: 'FIXED_FEE',
      feeAmountCents: 100_000,
    });
    const r = await invoke(f.router, 'get', '/:engagementId', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { engagementId: f.engagementId },
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      engagement: { id: string; name: string; feeStructure: string; feeAmountCents: number };
      rollup: {
        totalHours: number;
        wipCents: number;
        billableWipCents: number;
        realizationBps: number;
        realizationBasis: string;
        byUser: { appUserId: string; hours: number; amountCents: number; name: string }[];
        byWorkCode: { workCodeId: string; hours: number; amountCents: number; name: string }[];
      };
    };
    expect(body.engagement.id).toBe(f.engagementId);
    expect(body.rollup.totalHours).toBe(5);
    expect(body.rollup.wipCents).toBe(100_000);
    expect(body.rollup.billableWipCents).toBe(40_000);
    expect(body.rollup.realizationBps).toBe(10_000);
    expect(body.rollup.realizationBasis).toBe('FIXED_FEE');
    expect(body.rollup.byUser.length).toBe(1);
    expect(body.rollup.byUser[0]!.name).toBe('Sarah Chen');
    expect(body.rollup.byWorkCode[0]!.name).toBe('Tax Preparation');
  });

  it('hourly engagement → 100% realization by default', async () => {
    const f = await seedEngagementWithEntries({
      feeStructure: 'HOURLY',
      feeAmountCents: null,
    });
    const r = await invoke(f.router, 'get', '/:engagementId', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { engagementId: f.engagementId },
      }),
    });
    const body = r.jsonBody as {
      rollup: { realizationBps: number; realizationBasis: string };
    };
    expect(body.rollup.realizationBps).toBe(10_000);
    expect(body.rollup.realizationBasis).toBe('T_AND_M');
  });

  it('returns CSV when format=csv', async () => {
    const f = await seedEngagementWithEntries({
      feeStructure: 'FIXED_FEE',
      feeAmountCents: 100_000,
    });
    const r = await invoke(f.router, 'get', '/:engagementId', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { engagementId: f.engagementId },
        query: { format: 'csv' },
      }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain(`wip-${f.engagementId}.csv`);
    expect(r.body).toContain('# Engagement,Test Engagement');
    expect(r.body).toContain('By user');
    expect(r.body).toContain('Sarah Chen');
  });

  it('404 when engagement belongs to another firm', async () => {
    const f = await seedEngagementWithEntries({});
    // Create a second firm and a separate engagement under it.
    const second = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other Firm') RETURNING id`,
    );
    const otherFirmId = (second as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'b@x.example', 'B', 'B', 'B') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const r = await invoke(f.router, 'get', '/:engagementId', {
      ...makeReq({
        firmId: otherFirmId,
        appUserId: otherUserId,
        params: { engagementId: f.engagementId },
      }),
    });
    // The rbac middleware will reject before reaching the handler since
    // otherUserId has no roles. Wire fake role for them and re-test.
    const router2 = createWipRouter({
      db: harness.db,
      fakeUserRoles: new Map([[otherUserId, ['partner']]]),
    });
    const r2 = await invoke(router2, 'get', '/:engagementId', {
      ...makeReq({
        firmId: otherFirmId,
        appUserId: otherUserId,
        params: { engagementId: f.engagementId },
      }),
    });
    expect(r2.statusCode).toBe(404);
    expect((r2.jsonBody as { error: string }).error).toBe('engagement_not_found');
    // Swallow unused-var lint
    void r;
  });

  it('returns 404 for unknown engagement id', async () => {
    const f = await seedEngagementWithEntries({});
    const r = await invoke(f.router, 'get', '/:engagementId', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        params: { engagementId: '00000000-0000-4000-8000-000000000000' },
      }),
    });
    expect(r.statusCode).toBe(404);
  });
});
