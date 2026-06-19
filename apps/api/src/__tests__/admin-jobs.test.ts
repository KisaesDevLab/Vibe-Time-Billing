// SPDX-License-Identifier: Elastic-2.0
//
// Jobs admin — enable/disable, run history, and dry-run preview.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type express from 'express';

import type { RoleSlug } from '@vibe/core/rbac';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createAdminJobRouter } from '../admin/jobs';

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
  method: 'get' | 'post' | 'patch',
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

function req(
  opts: { params?: Record<string, string>; body?: unknown } = {},
): Record<string, unknown> {
  return {
    body: opts.body ?? {},
    params: opts.params ?? {},
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

function jobRouter(roles: RoleSlug[] = ['admin']) {
  return createAdminJobRouter({
    db: harness.db,
    redisUrl: 'redis://localhost:6379',
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
  });
}

describe('Jobs admin', () => {
  it('toggles a job disabled and reflects it in /schedules', async () => {
    const r = jobRouter();
    const patched = await invoke(r, 'patch', '/:name', {
      ...req({ params: { name: 'recurring-billing' }, body: { enabled: false } }),
    });
    expect(patched.statusCode).toBe(200);
    const sc = await invoke(r, 'get', '/schedules', { ...req() });
    const schedules = (sc.jsonBody as { schedules: Record<string, boolean> }).schedules;
    expect(schedules['recurring-billing']).toBe(false);
    // Untouched jobs default to enabled.
    expect(schedules['dunning-sweep']).toBe(true);
  });

  it('previews recurring-billing candidate count', async () => {
    // A plan due to bill today.
    await harness.db.execute(sql`
      INSERT INTO recurring_billing_plan (engagement_id, frequency, amount_cents, next_run_date, status)
      VALUES (${seed.engagementId}, 'MONTHLY', 50000, CURRENT_DATE, 'ACTIVE')`);
    const r = jobRouter();
    const res = await invoke(r, 'post', '/:name/preview', {
      ...req({ params: { name: 'recurring-billing' } }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as { supported: boolean; count: number };
    expect(body.supported).toBe(true);
    expect(body.count).toBeGreaterThanOrEqual(1);
  });

  it('returns empty run history initially', async () => {
    const r = jobRouter();
    const res = await invoke(r, 'get', '/:name/runs', {
      ...req({ params: { name: 'view-refresh' } }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { runs: unknown[] }).runs).toEqual([]);
  });

  it('reports no-preview for a job without a candidate query', async () => {
    const r = jobRouter();
    const res = await invoke(r, 'post', '/:name/preview', {
      ...req({ params: { name: 'view-refresh' } }),
    });
    expect((res.jsonBody as { supported: boolean }).supported).toBe(false);
  });
});
