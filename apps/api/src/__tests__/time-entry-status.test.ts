// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Change engagement progress status while logging time:
//  - staff-readable status-options list (engagement:read gated)
//  - time-entry create rejects an unknown workflow_state up-front (400),
//    before anything is created.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';

import { engagementStatusConfig } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createStatusOptionsRouter } from '../engagements/status-options';
import { createTimeEntryRouter } from '../time-entries/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await harness.db.insert(engagementStatusConfig).values([
    { firmId: seed.firmId, workflowState: 'NO_STATUS', label: 'No status', sortOrder: 0 },
    { firmId: seed.firmId, workflowState: 'IN_PROGRESS', label: 'In progress', sortOrder: 30 },
  ]);
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
function req(body: unknown): Record<string, unknown> {
  return {
    body: body ?? {},
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

describe('status options list', () => {
  function router(roles: RoleSlug[]) {
    return createStatusOptionsRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, roles]]),
    });
  }
  it('returns the firm catalog ordered by sortOrder', async () => {
    const r = await invoke(router(['staff']), 'get', '/', req({}));
    expect(r.statusCode).toBe(200);
    const items = (r.jsonBody as { items: Array<{ workflowState: string }> }).items;
    expect(items.map((i) => i.workflowState)).toEqual(['NO_STATUS', 'IN_PROGRESS']);
  });
  it('requires engagement:read (403 without it)', async () => {
    const r = await invoke(router([]), 'get', '/', req({}));
    expect(r.statusCode).toBe(403);
  });
});

describe('time-entry create with status change', () => {
  function router(roles: RoleSlug[]) {
    return createTimeEntryRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, roles]]),
    });
  }
  const today = new Date().toISOString().slice(0, 10);

  it('rejects an unknown workflow_state up-front (400, nothing created)', async () => {
    const r = await invoke(
      router(['partner']),
      'post',
      '/',
      req({ engagementId: seed.engagementId, entryDate: today, hours: 1, workflowState: 'GHOST' }),
    );
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('invalid_workflow_state');
  });
});

describe('GET /config — firm rounding increment', () => {
  function router(roles: RoleSlug[]) {
    return createTimeEntryRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, roles]]),
    });
  }

  it('defaults to 0.25 when no firm_settings row exists', async () => {
    const r = await invoke(router(['staff']), 'get', '/config', req({}));
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { roundingHours: string }).roundingHours).toBe('0.25');
  });

  it('returns the firm-configured increment (0.10)', async () => {
    const { firmSettings } = await import('@vibe/db/schema');
    await harness.db
      .insert(firmSettings)
      .values({ firmId: seed.firmId, timeEntryRoundingHours: '0.10' });
    const r = await invoke(router(['staff']), 'get', '/config', req({}));
    expect((r.jsonBody as { roundingHours: string }).roundingHours).toBe('0.10');
  });

  it('requires time_entry:create (403 without it)', async () => {
    const r = await invoke(router([]), 'get', '/config', req({}));
    expect(r.statusCode).toBe(403);
  });
});
