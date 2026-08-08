// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A1 (MIG-8 cost recovery) — client/engagement attribution threading.
// Attribution rides ONLY the driver request fields (→ router headers),
// never the prompt text; a client-supplied engagementId is resolved to
// the owning client server-side under firm scoping, and unresolvable ids
// silently drop attribution (telemetry, not authz).

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type express from 'express';
import type { Redis } from 'ioredis';

import type { AiProvider, AiCompletionRequest } from '@vibe/core/ai';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createAiRouter, runAiCompletion, runKbChat, type AiRoutesDeps } from '../ai/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const fakeRedis = { get: async () => null, set: async () => 'OK' } as unknown as Redis;

beforeAll(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});

afterAll(async () => {
  await harness.close();
});

function mockProvider(): { provider: AiProvider; lastReq: () => AiCompletionRequest | null } {
  let last: AiCompletionRequest | null = null;
  return {
    provider: {
      id: 'ollama',
      async complete(r: AiCompletionRequest) {
        last = r;
        return {
          text: 'ok',
          usage: { inputTokens: 3, outputTokens: 2 },
          providerId: 'ollama',
          costEstimateCents: 0,
        };
      },
    },
    lastReq: () => last,
  };
}

function deps(mock: { provider: AiProvider }): AiRoutesDeps {
  return {
    db: harness.db,
    redis: fakeRedis,
    localProvider: mock.provider,
    cloudProvider: null,
    fakeUserRoles: new Map([[seed.appUserId, ['staff']]]),
    now: () => new Date('2026-06-01T00:00:00Z'),
  };
}

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
async function invoke(router: express.Router, path: string, body: unknown): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods['post'] === true;
  });
  if (!layer) throw new Error(`route not registered: post ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  const reqObj = {
    body,
    params: {},
    query: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
  };
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(reqObj, res);
  return res;
}

describe('A1 attribution threading', () => {
  it('runKbChat forwards userId and clientId to the driver (the MIG-8 gap)', async () => {
    const mock = mockProvider();
    const out = await runKbChat(deps(mock), {
      firmId: seed.firmId,
      messages: [{ role: 'user', content: 'hello' }],
      actorAppUserId: seed.appUserId,
      clientId: seed.clientId,
    });
    expect(out.ok).toBe(true);
    const req = mock.lastReq()!;
    expect(req.userId).toBe(seed.appUserId);
    expect(req.clientRef).toBe(seed.clientId);
    // Never in the prompt.
    expect(`${req.systemPrompt}${req.userPrompt}`).not.toContain(seed.clientId);
  });

  it('runKbChat sends null attribution when the caller has none (staff chat)', async () => {
    const mock = mockProvider();
    await runKbChat(deps(mock), {
      firmId: seed.firmId,
      messages: [{ role: 'user', content: 'hello' }],
      actorAppUserId: null,
    });
    expect(mock.lastReq()!.userId).toBeNull();
    expect(mock.lastReq()!.clientRef).toBeNull();
  });

  it('runAiCompletion forwards clientId/engagementId as clientRef/engagementRef', async () => {
    const mock = mockProvider();
    const text = await runAiCompletion(deps(mock), {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      feature: 'pricing-rationale',
      systemPrompt: 'sys',
      userPrompt: 'user',
      clientId: seed.clientId,
      engagementId: seed.engagementId,
    });
    expect(text).toBe('ok');
    const req = mock.lastReq()!;
    expect(req.clientRef).toBe(seed.clientId);
    expect(req.engagementRef).toBe(seed.engagementId);
  });

  it('suggest-description resolves engagementId → owning client, firm-scoped', async () => {
    const mock = mockProvider();
    const router = createAiRouter(deps(mock));
    const r = await invoke(router, '/suggest-description', {
      engagementId: seed.engagementId,
      engagementName: 'Test Engagement',
    });
    expect(r.statusCode).toBe(200);
    const req = mock.lastReq()!;
    expect(req.clientRef).toBe(seed.clientId);
    expect(req.engagementRef).toBe(seed.engagementId);
    // Attribution never leaks into prompt text.
    expect(`${req.systemPrompt}${req.userPrompt}`).not.toContain(seed.engagementId);
  });

  it('an unknown engagementId drops attribution without failing the request', async () => {
    const mock = mockProvider();
    const router = createAiRouter(deps(mock));
    const r = await invoke(router, '/suggest-description', {
      engagementId: '00000000-0000-4000-8000-000000000000',
      engagementName: 'Test Engagement',
    });
    expect(r.statusCode).toBe(200);
    expect(mock.lastReq()!.clientRef).toBeNull();
    expect(mock.lastReq()!.engagementRef).toBeNull();
  });
});
