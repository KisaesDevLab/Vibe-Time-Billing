// SPDX-License-Identifier: Elastic-2.0
//
// Dismissing a worker alert removes it from the /alerts inbox (and therefore
// the dashboard callout, which reads the same endpoint).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';

import type { RoleSlug } from '@vibe/core/rbac';
import { auditLog } from '@vibe/db/schema';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createAuditRouter } from '../audit/routes';

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

function req(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: {},
    params: {},
    body: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
    ...extra,
  };
}

describe('Alert dismissal', () => {
  it('removes a dismissed alert from the inbox', async () => {
    const [alert] = await harness.db
      .insert(auditLog)
      .values({ action: 'UPDATE', entityType: 'wip_age_alert', entityId: seed.engagementId })
      .returning({ id: auditLog.id });
    const router = createAuditRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin'] as RoleSlug[]]]),
    });

    const before = await invoke(router, 'get', '/alerts', req());
    expect((before.jsonBody as { items: unknown[] }).items).toHaveLength(1);

    const dismiss = await invoke(
      router,
      'post',
      '/alerts/:id/dismiss',
      req({ params: { id: alert!.id } }),
    );
    expect(dismiss.statusCode).toBe(200);

    const after = await invoke(router, 'get', '/alerts', req());
    expect((after.jsonBody as { items: unknown[] }).items).toHaveLength(0);
  });

  it('rejects dismissing a non-alert id', async () => {
    const router = createAuditRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin'] as RoleSlug[]]]),
    });
    const res = await invoke(
      router,
      'post',
      '/alerts/:id/dismiss',
      req({ params: { id: seed.engagementId } }), // a real uuid, but not an alert row
    );
    expect(res.statusCode).toBe(404);
  });
});
