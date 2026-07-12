// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// /reports/time-by-staff-week — one row per staff × ISO week (Monday
// anchor), Mon..Sun day buckets + week total.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';

import { timeEntries } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createReportRouter } from '../reports/routes';

let h: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  h = await buildPgliteHarness();
  seed = await seedMinimalFirm(h.db);
});
afterEach(async () => {
  await h.close();
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
  query: Record<string, string>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods['get'] === true;
  });
  if (!layer) throw new Error(`route not registered: get ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const req = {
    query,
    params: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    header: () => undefined,
    get: () => undefined,
  };
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

interface WeekRow {
  staff: string;
  weekStart: string;
  weekEnd: string;
  mon: number;
  tue: number;
  wed: number;
  thu: number;
  fri: number;
  sat: number;
  sun: number;
  totalHours: number;
}

describe('GET /time-by-staff-week', () => {
  it('buckets days into Monday-anchored weeks with totals', async () => {
    const base = {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      standardRateSnapshotCents: 30000,
      standardAmountCents: 30000,
    };
    // 2026-07-06 is a Monday; 2026-07-12 a Sunday; 2026-07-13 next Monday.
    await h.db.insert(timeEntries).values([
      { ...base, entryDate: '2026-07-06', hours: '2.00' },
      { ...base, entryDate: '2026-07-06', hours: '1.50' }, // same day, sums
      { ...base, entryDate: '2026-07-12', hours: '3.00' },
      { ...base, entryDate: '2026-07-13', hours: '4.00' }, // next week
    ]);

    const router = createReportRouter({
      db: h.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, '/time-by-staff-week', {
      start: '2026-07-01',
      end: '2026-07-31',
    });
    expect(r.statusCode).toBe(200);
    const items = (r.jsonBody as { items: WeekRow[] }).items;
    expect(items).toHaveLength(2);

    // Most recent week first within the staff block.
    const [week2, week1] = items;
    expect(week2!.weekStart).toBe('2026-07-13');
    expect(week2!.mon).toBe(4);
    expect(week2!.totalHours).toBe(4);

    expect(week1!.weekStart).toBe('2026-07-06');
    expect(week1!.weekEnd).toBe('2026-07-12');
    expect(week1!.mon).toBe(3.5);
    expect(week1!.sun).toBe(3);
    expect(week1!.tue).toBe(0);
    expect(week1!.totalHours).toBe(6.5);
    expect(week1!.staff).toBeTruthy();
  });
});
