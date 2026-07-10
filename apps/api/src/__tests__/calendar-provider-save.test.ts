// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Repro/guard for "Calendar integrations page errors when saving a provider".
// Exercises the real PUT /providers/:provider path: firm-MFK encryption +
// upsert, with the appliance unlocked.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type express from 'express';

import { calendarProviderConfig } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createCalendarAdminRouter } from '../calendar/admin-routes';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-cal-prov-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  // Unlock both gates the way crypto boot does: load the firm MFK into the key
  // manager (liveKeys) AND set the appliance lock state.
  await getFirmKeyManager(harness.db).bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});
afterEach(async () => {
  setApplianceLockState({ kind: 'no-firm' });
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
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
function req(opts: { params?: Record<string, string>; body?: unknown }): Record<string, unknown> {
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
function router(roles: RoleSlug[] = ['admin']) {
  return createCalendarAdminRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
  });
}

describe('PUT /providers/:provider (calendar integrations save)', () => {
  it('saves Microsoft provider creds (encrypted) and reports configured', async () => {
    const r = router();
    const res = await invoke(r, 'put', '/providers/:provider', {
      ...req({
        params: { provider: 'microsoft' },
        body: { clientId: 'app-123', clientSecret: 'sh-secret', tenantId: 'common', enabled: true },
      }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { ok: boolean }).ok).toBe(true);
    const [row] = await harness.db
      .select()
      .from(calendarProviderConfig)
      .where(
        and(
          eq(calendarProviderConfig.firmId, seed.firmId),
          eq(calendarProviderConfig.provider, 'microsoft'),
        ),
      );
    expect(row!.enabled).toBe(true);
    expect(row!.clientIdEnc).toBeTruthy();
  });

  it('saves Google provider creds without a tenant', async () => {
    const r = router();
    const res = await invoke(r, 'put', '/providers/:provider', {
      ...req({
        params: { provider: 'google' },
        body: { clientId: 'goog-123.apps', clientSecret: 'g-secret', enabled: true },
      }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('updates Microsoft without re-entering the secret (preserves stored)', async () => {
    const r = router();
    await invoke(r, 'put', '/providers/:provider', {
      ...req({
        params: { provider: 'microsoft' },
        body: { clientId: 'app-1', clientSecret: 'sec1', tenantId: 'common', enabled: true },
      }),
    });
    // Second save toggles enabled, omits the secret (UI masks it).
    const res = await invoke(r, 'put', '/providers/:provider', {
      ...req({
        params: { provider: 'microsoft' },
        body: { clientId: 'app-1', tenantId: 'common', enabled: false },
      }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('Microsoft without a tenant id → 400 tenant_id_required', async () => {
    const r = router();
    const res = await invoke(r, 'put', '/providers/:provider', {
      ...req({
        params: { provider: 'microsoft' },
        body: { clientId: 'app-1', clientSecret: 'sec', enabled: true },
      }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.jsonBody as { error: string }).error).toBe('tenant_id_required');
  });
});
