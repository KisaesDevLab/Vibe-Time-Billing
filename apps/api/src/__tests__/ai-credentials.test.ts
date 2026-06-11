// SPDX-License-Identifier: Elastic-2.0
//
// 0100 — Admin AI credentials router + direct egress mode.
// Verifies: keys are encrypted at rest + returned only as a hint; updates
// without a key preserve it; delete clears the row; writes are gated by
// firm:settings:write; the test endpoint persists its outcome; and
// resolveEgressPolicy honours the new 'direct' mode.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import type express from 'express';

import { aiProviderCredential, firmConfig } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';
import type { AiProvider } from '@vibe/core/ai';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { createAiCredentialsRouter } from '../admin/ai-credentials/routes';
import { resolveEgressPolicy } from '../ai/egress';

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

describe('AI credentials router', () => {
  it('saves an Anthropic key encrypted and returns only a hint', async () => {
    const r = router();
    const put = await invoke(r, 'put', '/:providerId', {
      ...req(seed.firmId, seed.appUserId, {
        params: { providerId: 'anthropic' },
        body: { apiKey: 'sk-ant-secret-1234', model: 'claude-opus-4-7' },
      }),
    });
    expect(put.statusCode).toBe(200);

    // Stored ciphertext is not the plaintext; hint is the last 4.
    const [row] = await harness.db
      .select()
      .from(aiProviderCredential)
      .where(eq(aiProviderCredential.firmId, seed.firmId));
    expect(row!.apiKeyEncrypted).toBeTruthy();
    expect(new TextDecoder().decode(row!.apiKeyEncrypted!)).not.toContain('sk-ant-secret');
    expect(row!.apiKeyHint).toBe('••••1234');

    // GET redacts — no ciphertext, just the hint.
    const get = await invoke(r, 'get', '/', { ...req(seed.firmId, seed.appUserId) });
    const body = get.jsonBody as {
      providers: Array<{ providerId: string; hasKey: boolean; keyHint: string }>;
    };
    const a = body.providers.find((p) => p.providerId === 'anthropic')!;
    expect(a.hasKey).toBe(true);
    expect(a.keyHint).toBe('••••1234');
    expect(JSON.stringify(body)).not.toContain('sk-ant-secret');
  });

  it('update without apiKey keeps the stored key', async () => {
    const r = router();
    await invoke(r, 'put', '/:providerId', {
      ...req(seed.firmId, seed.appUserId, {
        params: { providerId: 'anthropic' },
        body: { apiKey: 'sk-ant-keep-9999' },
      }),
    });
    const [before] = await harness.db
      .select()
      .from(aiProviderCredential)
      .where(eq(aiProviderCredential.firmId, seed.firmId));

    await invoke(r, 'put', '/:providerId', {
      ...req(seed.firmId, seed.appUserId, {
        params: { providerId: 'anthropic' },
        body: { model: 'claude-haiku-4-5' },
      }),
    });
    const [after] = await harness.db
      .select()
      .from(aiProviderCredential)
      .where(eq(aiProviderCredential.firmId, seed.firmId));

    expect(after!.model).toBe('claude-haiku-4-5');
    expect(after!.apiKeyHint).toBe('••••9999');
    expect(Buffer.from(after!.apiKeyEncrypted!)).toEqual(Buffer.from(before!.apiKeyEncrypted!));
  });

  it('rejects an Anthropic provider with no key', async () => {
    const r = router();
    const put = await invoke(r, 'put', '/:providerId', {
      ...req(seed.firmId, seed.appUserId, {
        params: { providerId: 'anthropic' },
        body: { model: 'claude-opus-4-7' },
      }),
    });
    expect(put.statusCode).toBe(400);
    expect((put.jsonBody as { error: string }).error).toBe('api_key_required');
  });

  it('deletes a provider credential', async () => {
    const r = router();
    await invoke(r, 'put', '/:providerId', {
      ...req(seed.firmId, seed.appUserId, {
        params: { providerId: 'ollama' },
        body: { baseUrl: 'http://localhost:11434', model: 'qwen3:8b' },
      }),
    });
    const del = await invoke(r, 'delete', '/:providerId', {
      ...req(seed.firmId, seed.appUserId, { params: { providerId: 'ollama' } }),
    });
    expect(del.statusCode).toBe(200);
    const rows = await harness.db
      .select()
      .from(aiProviderCredential)
      .where(eq(aiProviderCredential.firmId, seed.firmId));
    expect(rows).toHaveLength(0);
  });

  it('requires firm:settings:write to save (403 for manager)', async () => {
    const r = router(['manager']);
    const put = await invoke(r, 'put', '/:providerId', {
      ...req(seed.firmId, seed.appUserId, {
        params: { providerId: 'anthropic' },
        body: { apiKey: 'sk-ant-x-0000' },
      }),
    });
    expect(put.statusCode).toBe(403);
  });

  it('test endpoint pings the provider and persists the outcome', async () => {
    let called = false;
    const fakeProvider: AiProvider = {
      id: 'anthropic',
      async complete() {
        called = true;
        return {
          text: 'pong',
          usage: { inputTokens: 1, outputTokens: 1 },
          providerId: 'anthropic',
          costEstimateCents: 0,
        };
      },
    };
    const r = router(['admin'], () => fakeProvider);
    await invoke(r, 'put', '/:providerId', {
      ...req(seed.firmId, seed.appUserId, {
        params: { providerId: 'anthropic' },
        body: { apiKey: 'sk-ant-test-5555' },
      }),
    });
    const test = await invoke(r, 'post', '/:providerId/test', {
      ...req(seed.firmId, seed.appUserId, { params: { providerId: 'anthropic' } }),
    });
    expect(test.statusCode).toBe(200);
    expect((test.jsonBody as { ok: boolean }).ok).toBe(true);
    expect(called).toBe(true);
    const [row] = await harness.db
      .select()
      .from(aiProviderCredential)
      .where(eq(aiProviderCredential.firmId, seed.firmId));
    expect(row!.status).toBe('OK');
    expect(row!.lastTestedAt).toBeTruthy();
  });
});

describe('egress direct mode', () => {
  const noRedis = { get: async () => null } as unknown as Redis;

  it('returns direct-ok when enabled with mode=direct (no shield needed)', async () => {
    await harness.db
      .insert(firmConfig)
      .values({ firmId: seed.firmId, aiEgressEnabled: true, aiEgressMode: 'direct' })
      .onConflictDoUpdate({
        target: firmConfig.firmId,
        set: { aiEgressEnabled: true, aiEgressMode: 'direct' },
      });
    const decision = await resolveEgressPolicy({
      db: harness.db,
      redis: noRedis,
      firmId: seed.firmId,
    });
    expect(decision.kind).toBe('direct-ok');
  });

  it('stays local-only when egress is disabled', async () => {
    await harness.db
      .insert(firmConfig)
      .values({ firmId: seed.firmId, aiEgressEnabled: false, aiEgressMode: 'direct' })
      .onConflictDoUpdate({
        target: firmConfig.firmId,
        set: { aiEgressEnabled: false, aiEgressMode: 'direct' },
      });
    const decision = await resolveEgressPolicy({
      db: harness.db,
      redis: noRedis,
      firmId: seed.firmId,
    });
    expect(decision.kind).toBe('local-only');
  });
});
