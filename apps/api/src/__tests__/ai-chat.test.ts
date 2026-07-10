// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// KB-grounded AI support chat: retrieves knowledge-base articles, injects
// them as context, returns the answer + sources. 503 when no provider.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type express from 'express';
import type { Redis } from 'ioredis';

import { seedKnowledgeBase } from '@vibe/db';
import type { AiProvider, AiCompletionRequest } from '@vibe/core/ai';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createAiRouter } from '../ai/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

// Egress defaults to local-only (no firm_config row), so this stub is
// never actually read — but pickProvider passes it through.
const fakeRedis = { get: async () => null, set: async () => 'OK' } as unknown as Redis;

beforeAll(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await seedKnowledgeBase(harness.db, seed.firmId);
});

afterAll(async () => {
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

function mockProvider(): { provider: AiProvider; lastReq: () => AiCompletionRequest | null } {
  let last: AiCompletionRequest | null = null;
  return {
    provider: {
      id: 'ollama',
      async complete(r: AiCompletionRequest) {
        last = r;
        return {
          text: 'Open the client and choose "Invite to portal".',
          usage: { inputTokens: 12, outputTokens: 9 },
          providerId: 'ollama',
          costEstimateCents: 0,
        };
      },
    },
    lastReq: () => last,
  };
}

describe('AI support chat', () => {
  it('grounds the answer in retrieved KB articles and returns sources', async () => {
    const mock = mockProvider();
    const router = createAiRouter({
      db: harness.db,
      redis: fakeRedis,
      localProvider: mock.provider,
      cloudProvider: null,
      fakeUserRoles: new Map([[seed.appUserId, ['staff']]]),
      now: () => new Date('2026-06-01T00:00:00Z'),
    });
    const r = await invoke(router, '/chat', {
      messages: [{ role: 'user', content: 'How do I invite a client to the portal?' }],
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { message: string; sources: Array<{ slug: string }> };
    expect(body.message).toContain('Invite to portal');
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.sources.some((s) => s.slug.includes('portal'))).toBe(true);

    // The retrieved article was injected into the system prompt.
    const sys = mock.lastReq()?.systemPrompt ?? '';
    expect(sys).toContain('SUPPORT ARTICLES');
    expect(sys.toLowerCase()).toContain('portal');
  });

  it('returns 503 when no AI provider is wired', async () => {
    const router = createAiRouter({
      db: harness.db,
      redis: fakeRedis,
      localProvider: null,
      cloudProvider: null,
      fakeUserRoles: new Map([[seed.appUserId, ['staff']]]),
      now: () => new Date('2026-06-01T00:00:00Z'),
    });
    const r = await invoke(router, '/chat', {
      messages: [{ role: 'user', content: 'anything' }],
    });
    expect(r.statusCode).toBe(503);
  });

  it('rejects an empty message list', async () => {
    const mock = mockProvider();
    const router = createAiRouter({
      db: harness.db,
      redis: fakeRedis,
      localProvider: mock.provider,
      cloudProvider: null,
      fakeUserRoles: new Map([[seed.appUserId, ['staff']]]),
      now: () => new Date('2026-06-01T00:00:00Z'),
    });
    const r = await invoke(router, '/chat', { messages: [] });
    expect(r.statusCode).toBe(400);
  });
});
