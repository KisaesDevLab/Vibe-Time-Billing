// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// GET /time-entries/list — server-side pagination envelope, the q free-text
// search (description / client / engagement), and the hours/amount totals that
// span the WHOLE filtered set (the UI footer), not just the page.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';

import type { RoleSlug } from '@vibe/core/rbac';
import { timeEntries } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTimeEntryRouter } from '../time-entries/routes';

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
  method: 'get' | 'post',
  path: string,
  reqObj: Record<string, unknown>,
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
      reqObj,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(reqObj, res);
  return res;
}
function req(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
    ...over,
  };
}

function router() {
  return createTimeEntryRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['admin' as RoleSlug]]]),
  });
}

async function logTime(description: string, hours: number): Promise<void> {
  // Insert directly (bypasses the create-time engagement-writable guard).
  await harness.db.insert(timeEntries).values({
    engagementId: seed.engagementId,
    appUserId: seed.appUserId,
    entryDate: '2026-06-10',
    hours: hours.toFixed(2),
    standardRateSnapshotCents: 30000,
    standardAmountCents: Math.round(hours * 30000),
    costRateSnapshotCents: 12000,
    description,
  });
}

describe('GET /time-entries/list', () => {
  it('paginates and totals span the whole filtered set', async () => {
    await logTime('alpha work', 2);
    await logTime('beta work', 3);

    const r = await invoke(router(), 'get', '/list', req({ query: { page: '1', pageSize: '1' } }));
    const body = r.jsonBody as {
      rows: unknown[];
      total: number;
      pageSize: number;
      sumHours: number;
    };
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(1); // page holds 1…
    expect(body.sumHours).toBe(5); // …but totals span both (2 + 3)
  });

  it('q filters by description', async () => {
    await logTime('alpha work', 2);
    await logTime('beta work', 3);

    const r = await invoke(
      router(),
      'get',
      '/list',
      req({ query: { page: '1', pageSize: '50', q: 'alpha' } }),
    );
    const body = r.jsonBody as { total: number; sumHours: number };
    expect(body.total).toBe(1);
    expect(body.sumHours).toBe(2);
  });
});
