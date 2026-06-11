// SPDX-License-Identifier: Elastic-2.0
//
// Portal-facing KB help + AI support chat. The portal must only ever see
// client-visible (audience client/both) articles — staff content must never
// leak into a client's search, browse, or chat grounding.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type express from 'express';
import type { Redis } from 'ioredis';

import { seedKnowledgeBase } from '@vibe/db';
import type { AiProvider } from '@vibe/core/ai';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createPortalAiRouter } from '../ai/portal-routes';
import { kbChatAvailable } from '../ai/routes';
import {
  PORTAL_AUDIENCES,
  getKbArticleForAudience,
  listKbCategoriesForAudience,
  searchKbArticles,
} from '../help/queries';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const fakeRedis = { get: async () => null, set: async () => 'OK' } as unknown as Redis;

const noAuth = (_req: unknown, _res: unknown, next: () => void): void => next();

function mockProvider(): AiProvider {
  return {
    id: 'ollama',
    async complete() {
      return {
        text: 'Open Invoices, choose the invoice, and select Pay.',
        usage: { inputTokens: 10, outputTokens: 8 },
        providerId: 'ollama',
        costEstimateCents: 0,
      };
    },
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

// Invoke the last handler of a POST route (bypasses the auth middleware,
// which is exercised elsewhere) with a portal session attached.
async function invokePost(router: express.Router, path: string, body: unknown): Promise<FakeRes> {
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
    portalSession: {
      realm: 'portal',
      firmId: seed.firmId,
      portalIdentityId: '00000000-0000-0000-0000-000000000001',
      activeClientId: seed.clientId,
    },
  };
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(reqObj, res);
  return res;
}

beforeAll(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await seedKnowledgeBase(harness.db, seed.firmId);
});

afterAll(async () => {
  await harness.close();
});

describe('portal KB audience scoping', () => {
  it('searchKbArticles restricts to client-visible articles', async () => {
    const staffHits = await searchKbArticles(harness.db, seed.firmId, 'invoice', 8);
    const clientHits = await searchKbArticles(
      harness.db,
      seed.firmId,
      'invoice',
      8,
      PORTAL_AUDIENCES,
    );
    // Staff search sees the internal article; the client search does not.
    expect(staffHits.some((h) => h.slug === 'creating-invoices')).toBe(true);
    expect(clientHits.length).toBeGreaterThan(0);
    expect(clientHits.some((h) => h.slug === 'creating-invoices')).toBe(false);
    expect(clientHits.every((h) => h.slug.startsWith('client-'))).toBe(true);
  });

  it('lists only categories with client-visible articles', async () => {
    const cats = await listKbCategoriesForAudience(harness.db, seed.firmId, PORTAL_AUDIENCES);
    expect(cats.some((c) => c.slug === 'client-help')).toBe(true);
    // A staff-only category never surfaces to the portal.
    expect(cats.some((c) => c.slug === 'time-tracking')).toBe(false);
  });

  it('fetches a client article but not a staff-only one', async () => {
    const ok = await getKbArticleForAudience(
      harness.db,
      seed.firmId,
      'client-signing-in',
      PORTAL_AUDIENCES,
    );
    expect(ok?.title).toContain('Signing in');
    const leaked = await getKbArticleForAudience(
      harness.db,
      seed.firmId,
      'creating-invoices',
      PORTAL_AUDIENCES,
    );
    expect(leaked).toBeNull();
  });
});

describe('portal AI support chat', () => {
  function router(provider: AiProvider | null): express.Router {
    return createPortalAiRouter({
      db: harness.db,
      redis: fakeRedis,
      localProvider: provider,
      cloudProvider: null,
      requireAuth: noAuth,
      now: () => new Date('2026-06-01T00:00:00Z'),
    });
  }

  it('answers using only client-visible articles as sources', async () => {
    const r = await invokePost(router(mockProvider()), '/chat', {
      messages: [{ role: 'user', content: 'How do I pay an invoice?' }],
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { message: string; sources: Array<{ slug: string }> };
    expect(body.message).toContain('Pay');
    expect(body.sources.length).toBeGreaterThan(0);
    // Every grounding source is a client-facing article — no staff leakage.
    expect(body.sources.every((s) => s.slug.startsWith('client-'))).toBe(true);
    expect(body.sources.some((s) => s.slug === 'creating-invoices')).toBe(false);
  });

  it('returns 503 when no AI provider is wired', async () => {
    const r = await invokePost(router(null), '/chat', {
      messages: [{ role: 'user', content: 'anything' }],
    });
    expect(r.statusCode).toBe(503);
  });

  it('rejects an empty message list', async () => {
    const r = await invokePost(router(mockProvider()), '/chat', { messages: [] });
    expect(r.statusCode).toBe(400);
  });

  it('kbChatAvailable reflects provider wiring', async () => {
    const deps = {
      db: harness.db,
      redis: fakeRedis,
      localProvider: mockProvider(),
      cloudProvider: null,
      now: () => new Date('2026-06-01T00:00:00Z'),
    };
    expect(await kbChatAvailable(deps, seed.firmId)).toBe(true);
    expect(await kbChatAvailable({ ...deps, localProvider: null }, seed.firmId)).toBe(false);
  });
});
