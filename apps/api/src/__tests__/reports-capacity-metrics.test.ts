// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Smoke + correctness for the capacity-style metrics that gained additive
// fields: utilization (availableHours / capacityUtilizationPct),
// capacity-forecast (standardWeeklyHours / varianceVsCapacity), and
// billable-targets (proratedTargetHours). Guards against SQL/groupBy errors
// and pins the capacity arithmetic.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { timeEntries } from '@vibe/db/schema';
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

describe('Reports — capacity metrics (additive fields)', () => {
  it('utilization, capacity-forecast and billable-targets return the new fields', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // One recent billable entry so every windowed metric has a row.
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    await harness.db.insert(timeEntries).values({
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      entryDate: recent,
      hours: '8.00',
      standardRateSnapshotCents: 30000,
      standardAmountCents: 240000,
      billableFlag: true,
    });
    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });

    const util = await invoke(router, '/utilization', seed.firmId, seed.appUserId);
    expect(util.statusCode).toBe(200);
    const u = (util.jsonBody as { items: Array<Record<string, number>> }).items.find(
      (i) => i['appUserId'] === (seed.appUserId as unknown as number),
    )!;
    // Default standard week is 40h → 30-day capacity ≈ 40 × 30/7 ≈ 171.43h.
    expect(u['availableHours']).toBeCloseTo((40 * 30) / 7, 1);
    expect(typeof u['capacityUtilizationPct']).toBe('number');

    const cap = await invoke(router, '/capacity-forecast', seed.firmId, seed.appUserId);
    expect(cap.statusCode).toBe(200);
    const c = (cap.jsonBody as { items: Array<Record<string, number>> }).items[0]!;
    expect(c['standardWeeklyHours']).toBe(40);
    expect(c).toHaveProperty('varianceVsCapacity');
    expect(c).toHaveProperty('capacityUtilizationPct');

    const tgt = await invoke(router, '/billable-targets', seed.firmId, seed.appUserId);
    expect(tgt.statusCode).toBe(200);
    const body = tgt.jsonBody as {
      monthElapsedPct: number;
      items: Array<Record<string, number>>;
    };
    expect(typeof body.monthElapsedPct).toBe('number');
    const t = body.items[0]!;
    expect(t).toHaveProperty('proratedTargetHours');
    expect(t).toHaveProperty('proratedAttainmentPct');
    // Prorated target never exceeds the full-month target.
    expect(t['proratedTargetHours']!).toBeLessThanOrEqual(t['targetHours']!);
  });
});
