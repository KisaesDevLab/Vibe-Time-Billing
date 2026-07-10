// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Optional ?start=/?end= windows actually narrow report results.

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
  query: Record<string, string>,
  session: { firmId: string; appUserId: string },
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods['get'] === true;
  });
  if (!layer) throw new Error(`route not registered: GET ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const chain = route.stack;
  const req = {
    body: {},
    params: {},
    query,
    staffSession: session,
    ip: '127.0.0.1',
    get: () => undefined,
  };
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

function hoursFor(res: FakeRes, engagementId: string): number {
  const body = res.jsonBody as { items: Array<{ engagementId: string; hours: number }> };
  return body.items.find((i) => i.engagementId === engagementId)?.hours ?? 0;
}

describe('Reports — optional date filters', () => {
  it('time-by-engagement honours ?start / ?end windows', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.insert(timeEntries).values([
      {
        engagementId: seed.engagementId,
        appUserId: seed.appUserId,
        workCodeId: seed.workCodeId,
        entryDate: '2026-01-10',
        hours: '5.00',
        standardRateSnapshotCents: 30000,
        standardAmountCents: 150000,
        costRateSnapshotCents: 10000,
      },
      {
        engagementId: seed.engagementId,
        appUserId: seed.appUserId,
        workCodeId: seed.workCodeId,
        entryDate: '2026-04-15',
        hours: '3.00',
        standardRateSnapshotCents: 30000,
        standardAmountCents: 90000,
        costRateSnapshotCents: 10000,
      },
    ]);
    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
    });
    const session = { firmId: seed.firmId, appUserId: seed.appUserId };

    // No window → both entries (8h).
    expect(
      hoursFor(await invoke(router, '/time-by-engagement', {}, session), seed.engagementId),
    ).toBe(8);
    // start cuts off the January entry → 3h.
    expect(
      hoursFor(
        await invoke(router, '/time-by-engagement', { start: '2026-03-01' }, session),
        seed.engagementId,
      ),
    ).toBe(3);
    // end cuts off the April entry → 5h.
    expect(
      hoursFor(
        await invoke(router, '/time-by-engagement', { end: '2026-02-01' }, session),
        seed.engagementId,
      ),
    ).toBe(5);
  });
});
