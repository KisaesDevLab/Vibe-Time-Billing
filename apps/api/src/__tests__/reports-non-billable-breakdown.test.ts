// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0208 follow-up — /reports/non-billable-breakdown: non-billable hours by
// work code with the firm-admin vs client-engagement split. Billable
// entries never appear.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';
import { eq } from 'drizzle-orm';

import { engagements, timeEntries } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createReportRouter } from '../reports/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
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
  method: 'get',
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const chain = route.stack;
  for (let i = 0; i < chain.length - 1; i++) {
    let advanced = false;
    await (chain[i]!.handle as (rq: unknown, rs: unknown, nx: () => void) => unknown)(
      req,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(req, res);
  return res;
}

const TODAY = new Date().toISOString().slice(0, 10);

interface Row {
  workCodeId: string | null;
  workCode: string;
  hours: number;
  entries: number;
  pctOfNonBillable: number;
  firmAdminHours: number;
  clientHours: number;
}

describe('GET /non-billable-breakdown', () => {
  it('groups non-billable hours by work code with the firm-admin split', async () => {
    // Make the seed engagement the firm-admin one.
    await harness.db
      .update(engagements)
      .set({ firmAdmin: true, status: 'ACTIVE' })
      .where(eq(engagements.id, seed.engagementId));

    const base = {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      entryDate: TODAY,
      standardRateSnapshotCents: 30000,
    };
    await harness.db.insert(timeEntries).values([
      // 3h of coded non-billable admin time.
      {
        ...base,
        workCodeId: seed.workCodeId,
        hours: '3.00',
        standardAmountCents: 90000,
        billableFlag: false,
      },
      // 1h of uncoded non-billable admin time.
      {
        ...base,
        workCodeId: null,
        hours: '1.00',
        standardAmountCents: 30000,
        billableFlag: false,
      },
      // Billable time must not appear at all.
      {
        ...base,
        workCodeId: seed.workCodeId,
        hours: '8.00',
        standardAmountCents: 240000,
        billableFlag: true,
      },
    ]);

    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'get', '/non-billable-breakdown', {
      query: {},
      params: {},
      headers: {},
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      header: () => undefined,
      get: () => undefined,
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { totalNonBillableHours: number; items: Row[] };
    expect(body.totalNonBillableHours).toBe(4);
    expect(body.items).toHaveLength(2);

    const coded = body.items.find((i) => i.workCodeId === seed.workCodeId)!;
    expect(coded.hours).toBe(3);
    expect(coded.entries).toBe(1);
    expect(coded.pctOfNonBillable).toBe(75);
    expect(coded.firmAdminHours).toBe(3); // all of it on the admin engagement
    expect(coded.clientHours).toBe(0);

    const uncoded = body.items.find((i) => i.workCodeId === null)!;
    expect(uncoded.workCode).toBe('(no work code)');
    expect(uncoded.hours).toBe(1);
    expect(uncoded.pctOfNonBillable).toBe(25);

    // Sorted by hours desc.
    expect(body.items[0]!.hours).toBeGreaterThanOrEqual(body.items[1]!.hours);
  });

  it('splits client-engagement non-billable time from firm-admin time', async () => {
    // Seed engagement stays a normal client engagement (firm_admin=false).
    await harness.db.insert(timeEntries).values({
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      entryDate: TODAY,
      hours: '2.00',
      standardRateSnapshotCents: 30000,
      standardAmountCents: 60000,
      billableFlag: false,
    });
    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'get', '/non-billable-breakdown', {
      query: {},
      params: {},
      headers: {},
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      header: () => undefined,
      get: () => undefined,
    });
    const body = r.jsonBody as { items: Row[] };
    const row = body.items.find((i) => i.workCodeId === seed.workCodeId)!;
    expect(row.firmAdminHours).toBe(0);
    expect(row.clientHours).toBe(2);
  });
});
