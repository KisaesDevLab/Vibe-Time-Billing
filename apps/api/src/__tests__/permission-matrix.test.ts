// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0147 — editable permission matrix. Verifies: GET overlays firm
// overrides on the templates (with overridden markers); PUT upserts a
// delta, clears it when toggled back to the template default, rejects
// the admin role and unknown keys; and requirePermission actually
// enforces the deltas (revoke → 403, grant → pass).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { and, eq } from 'drizzle-orm';

import { rolePermissionOverrides } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createAdminRouter } from '../admin/routes';
import { requirePermission } from '../auth/rbac-middleware';

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
  method: 'get' | 'put' | 'post',
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

function req(body: unknown = {}): Record<string, unknown> {
  return {
    body,
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

function adminRouter(roles: RoleSlug[] = ['admin']) {
  return createAdminRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
  });
}

interface MatrixBody {
  permissions: Array<{ key: string; roles: string[]; overridden: string[] }>;
  roles: string[];
}

describe('permission matrix endpoints', () => {
  it('PUT revokes a template grant; GET reflects it with an overridden marker', async () => {
    const r = adminRouter();
    const put = await invoke(r, 'put', '/permission-matrix', {
      ...req({ role: 'manager', key: 'approval:act', granted: false }),
    });
    expect(put.statusCode).toBe(200);
    expect(put.jsonBody).toMatchObject({ overridden: true });

    const get = await invoke(r, 'get', '/permission-matrix', { ...req() });
    const row = (get.jsonBody as MatrixBody).permissions.find((p) => p.key === 'approval:act')!;
    expect(row.roles).not.toContain('manager');
    expect(row.overridden).toContain('manager');
    // partner untouched.
    expect(row.roles).toContain('partner');
  });

  it('PUT grants a key the template lacks, and toggling back clears the row', async () => {
    const r = adminRouter();
    await invoke(r, 'put', '/permission-matrix', {
      ...req({ role: 'staff', key: 'invoice:write', granted: true }),
    });
    let rows = await harness.db
      .select()
      .from(rolePermissionOverrides)
      .where(eq(rolePermissionOverrides.firmId, seed.firmId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.granted).toBe(true);

    // Back to the template default → override row removed.
    await invoke(r, 'put', '/permission-matrix', {
      ...req({ role: 'staff', key: 'invoice:write', granted: false }),
    });
    rows = await harness.db
      .select()
      .from(rolePermissionOverrides)
      .where(eq(rolePermissionOverrides.firmId, seed.firmId));
    expect(rows).toHaveLength(0);
  });

  it('rejects the admin role, unknown keys, and non-admin editors', async () => {
    const r = adminRouter();
    expect(
      (
        await invoke(r, 'put', '/permission-matrix', {
          ...req({ role: 'admin', key: 'invoice:write', granted: false }),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await invoke(r, 'put', '/permission-matrix', {
          ...req({ role: 'staff', key: 'not:a:key', granted: true }),
        })
      ).statusCode,
    ).toBe(400);
    // manager lacks firm:settings:write → 403 before the handler runs.
    expect(
      (
        await invoke(adminRouter(['manager']), 'put', '/permission-matrix', {
          ...req({ role: 'staff', key: 'invoice:write', granted: true }),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('requirePermission enforces overrides live (revoke → 403, grant → pass)', async () => {
    const deps = {
      db: harness.db,
      fakeUserRoles: new Map<string, RoleSlug[]>([[seed.appUserId, ['manager']]]),
    };
    const guarded = express.Router();
    guarded.get('/probe', requirePermission(deps, 'approval:act'), (_rq, rs) => {
      (rs as unknown as FakeRes).json({ ok: true });
    });

    // Baseline: manager template has approval:act.
    expect((await invoke(guarded, 'get', '/probe', { ...req() })).statusCode).toBe(200);

    // Revoke it via override → 403.
    await harness.db.insert(rolePermissionOverrides).values({
      firmId: seed.firmId,
      roleSlug: 'manager',
      permissionKey: 'approval:act',
      granted: false,
      updatedBy: seed.appUserId,
    });
    expect((await invoke(guarded, 'get', '/probe', { ...req() })).statusCode).toBe(403);

    // Flip the override to a grant → passes again.
    await harness.db
      .update(rolePermissionOverrides)
      .set({ granted: true })
      .where(
        and(
          eq(rolePermissionOverrides.firmId, seed.firmId),
          eq(rolePermissionOverrides.roleSlug, 'manager'),
        ),
      );
    expect((await invoke(guarded, 'get', '/probe', { ...req() })).statusCode).toBe(200);
  });
});
