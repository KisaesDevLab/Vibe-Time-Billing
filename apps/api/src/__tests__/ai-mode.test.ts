// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0222 — AI routing mode switch in Admin → AI settings: firm_config.ai_mode
// overrides VIBE_AI_MODE; router mode needs URL + token (MFK-wrapped);
// the runtime resolver degrades a half-configured router to direct with a
// stated problem; env mode follows the env var.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type express from 'express';

import { firmConfig } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';
import type { AiProvider } from '@vibe/core/ai';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { createAiCredentialsRouter } from '../admin/ai-credentials/routes';
import { _resetAiRuntimeForTests, getAiRuntime, refreshAiRuntime } from '../ai/ai-runtime';
import { aiMode } from '../ai/vibe-router';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-ai-seal-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
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

// Runs the FULL handler chain (so requirePermission middleware executes).
async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'put' | 'delete',
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
  firmId: string,
  appUserId: string,
  opts: { params?: Record<string, string>; body?: unknown } = {},
): Record<string, unknown> {
  return {
    body: opts.body ?? {},
    params: opts.params ?? {},
    query: {},
    headers: {},
    staffSession: { firmId, appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

function router(roles: RoleSlug[] = ['admin'], buildTestProvider?: () => AiProvider) {
  return createAiCredentialsRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
    buildTestProvider,
  });
}

describe('AI mode switch (0222)', () => {
  beforeEach(() => {
    delete process.env['VIBE_AI_MODE'];
    delete process.env['VIBE_AI_ROUTER_URL'];
    delete process.env['VIBE_AI_TOKEN'];
    _resetAiRuntimeForTests();
  });

  it('defaults to env (direct) and reports the config shape', async () => {
    await refreshAiRuntime(harness.db);
    expect(aiMode()).toBe('direct');
    const r = await invoke(router(), 'get', '/', req(seed.firmId, seed.appUserId));
    const cfg = (r.jsonBody as { aiModeConfig: Record<string, unknown> }).aiModeConfig;
    expect(cfg['setting']).toBe('env');
    expect(cfg['effective']).toBe('direct');
    expect(cfg['source']).toBe('env');
    expect(cfg['hasToken']).toBe(false);
  });

  it('firm "direct" overrides an env router setting', async () => {
    process.env['VIBE_AI_MODE'] = 'router';
    process.env['VIBE_AI_ROUTER_URL'] = 'https://env-router.test';
    process.env['VIBE_AI_TOKEN'] = 'env-token';
    _resetAiRuntimeForTests();
    expect(aiMode()).toBe('router');
    const r = await invoke(
      router(),
      'put',
      '/ai-mode',
      req(seed.firmId, seed.appUserId, { body: { mode: 'direct' } }),
    );
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { effective: string }).effective).toBe('direct');
    expect(aiMode()).toBe('direct');
    expect(getAiRuntime().source).toBe('firm');
  });

  it('router mode needs URL + token; stores the token encrypted; resolves to router', async () => {
    const missing = await invoke(
      router(),
      'put',
      '/ai-mode',
      req(seed.firmId, seed.appUserId, { body: { mode: 'router', routerUrl: 'https://r.test/' } }),
    );
    expect(missing.statusCode).toBe(400);

    const ok = await invoke(
      router(),
      'put',
      '/ai-mode',
      req(seed.firmId, seed.appUserId, {
        body: { mode: 'router', routerUrl: 'https://r.test/', token: 'vr_secret_token_1234' },
      }),
    );
    expect(ok.statusCode).toBe(200);
    expect((ok.jsonBody as { effective: string; problem: string | null }).effective).toBe('router');

    const [row] = await harness.db
      .select()
      .from(firmConfig)
      .where(eq(firmConfig.firmId, seed.firmId));
    expect(row!.aiMode).toBe('router');
    expect(row!.aiRouterUrl).toBe('https://r.test');
    expect(row!.aiRouterTokenHint).toBe('••••1234');
    expect(row!.aiRouterTokenEncrypted).not.toBeNull();
    // Encrypted, not plaintext.
    expect(Buffer.from(row!.aiRouterTokenEncrypted!).toString('utf8')).not.toContain('vr_secret');

    const rt = getAiRuntime();
    expect(rt.mode).toBe('router');
    expect(rt.routerUrl).toBe('https://r.test');
    expect(rt.routerToken).toBe('vr_secret_token_1234');

    // GET never leaks the token.
    const g = await invoke(router(), 'get', '/', req(seed.firmId, seed.appUserId));
    const cfg = (g.jsonBody as { aiModeConfig: Record<string, unknown> }).aiModeConfig;
    expect(cfg['hasToken']).toBe(true);
    expect(cfg['tokenHint']).toBe('••••1234');
    expect(JSON.stringify(g.jsonBody)).not.toContain('vr_secret');
  });

  it('a sealed appliance degrades a firm router setting to direct with a problem', async () => {
    await invoke(
      router(),
      'put',
      '/ai-mode',
      req(seed.firmId, seed.appUserId, {
        body: { mode: 'router', routerUrl: 'https://r.test', token: 'tok-abcd' },
      }),
    );
    setApplianceLockState({ kind: 'sealed' } as never);
    const rt = await refreshAiRuntime(harness.db);
    expect(rt.mode).toBe('direct');
    expect(rt.firmSetting).toBe('router');
    expect(rt.problem).toBe('appliance_locked');
    setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
  });

  it('switching back to env restores the env behaviour', async () => {
    await invoke(
      router(),
      'put',
      '/ai-mode',
      req(seed.firmId, seed.appUserId, { body: { mode: 'direct' } }),
    );
    const r = await invoke(
      router(),
      'put',
      '/ai-mode',
      req(seed.firmId, seed.appUserId, { body: { mode: 'env' } }),
    );
    expect(r.statusCode).toBe(200);
    expect(getAiRuntime().source).toBe('env');
  });

  it('requires firm:settings:write', async () => {
    const r = await invoke(
      router(['staff']),
      'put',
      '/ai-mode',
      req(seed.firmId, seed.appUserId, { body: { mode: 'direct' } }),
    );
    expect(r.statusCode).toBe(403);
  });
});
