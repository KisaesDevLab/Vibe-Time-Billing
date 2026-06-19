// SPDX-License-Identifier: Elastic-2.0
//
// The audit list resolves actor + entity names and returns full ids.

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
  path: string,
  req: Record<string, unknown>,
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

function req(): Record<string, unknown> {
  return {
    query: {},
    params: {},
    body: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}

describe('Audit log name resolution', () => {
  it('returns full ids + resolved actor and entity names', async () => {
    await harness.db.insert(auditLog).values({
      action: 'UPDATE',
      entityType: 'engagement',
      entityId: seed.engagementId,
      actorAppUserId: seed.appUserId,
    });
    const router = createAuditRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin'] as RoleSlug[]]]),
    });
    const res = await invoke(router, '/', req());
    expect(res.statusCode).toBe(200);
    const items = (
      res.jsonBody as {
        items: Array<{ actorName: string | null; entityName: string | null; entityId: string }>;
      }
    ).items;
    expect(items.length).toBe(1);
    expect(items[0]!.entityId).toBe(seed.engagementId); // full uuid, not truncated
    expect(items[0]!.entityName).toBeTruthy(); // engagement name
    expect(items[0]!.actorName).toBeTruthy(); // app-user full name
  });
});
