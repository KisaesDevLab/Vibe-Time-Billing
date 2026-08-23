// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// MIG-8 — router driver wire contract via injected fetch, no network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  FEATURE_TASK_CLASS,
  TIMEBILL_TASK_CLASSES,
  _clearRouterProviderCacheForTests,
  aiMode,
  createVibeRouterProvider,
  registerTimeBillingTaskClasses,
  taskClassForFeature,
} from './vibe-router';

const ENV_KEYS = ['VIBE_AI_MODE', 'VIBE_AI_ROUTER_URL', 'VIBE_AI_TOKEN'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['VIBE_AI_MODE'] = 'router';
  process.env['VIBE_AI_ROUTER_URL'] = 'http://router.test:8220';
  process.env['VIBE_AI_TOKEN'] = 'tok';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _clearRouterProviderCacheForTests();
});

function captureFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, fn };
}

function completionResponse(): Response {
  return new Response(
    JSON.stringify({
      model: 'ollama/qwen3:14b',
      choices: [{ message: { content: 'narrative text' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 21, completion_tokens: 9 },
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' } },
  );
}

describe('mode + mapping', () => {
  it('aiMode reads the env', () => {
    expect(aiMode()).toBe('router');
    process.env['VIBE_AI_MODE'] = 'direct';
    expect(aiMode()).toBe('direct');
  });

  it('every pickProvider feature string is mapped; unknown features fail closed', () => {
    for (const feature of [
      'suggest-description',
      'realization-narrative',
      'plain-english-query',
      'pricing-suggestion',
      'pricing-rationale',
      'write-down-patterns',
      'reason-code-suggest',
      'prebill-narrative',
      'anomaly-summary',
      'nl-to-filter',
      'scope-creep-narrative',
      'capacity-narrative',
      'support-chat',
      'status-probe',
    ]) {
      expect(FEATURE_TASK_CLASS[feature], feature).toBeTruthy();
    }
    expect(() => taskClassForFeature('brand-new-feature')).toThrow(/no task-class mapping/);
    expect(() => taskClassForFeature(undefined)).toThrow(/no task-class mapping/);
  });

  it('billing-text features ride the pack class; analytics and chat get the new classes', () => {
    expect(FEATURE_TASK_CLASS['suggest-description']).toBe(TIMEBILL_TASK_CLASSES.INVOICE_NARRATIVE);
    expect(FEATURE_TASK_CLASS['realization-narrative']).toBe(
      TIMEBILL_TASK_CLASSES.PRACTICE_ANALYTICS,
    );
    expect(FEATURE_TASK_CLASS['support-chat']).toBe(TIMEBILL_TASK_CLASSES.SUPPORT_CHAT);
  });
});

describe('createVibeRouterProvider', () => {
  it('sends task-class header + attribution and never an app-pinned model', async () => {
    const { calls, fn } = captureFetch(completionResponse);
    const provider = createVibeRouterProvider({
      baseUrl: 'http://router.test:8220',
      token: 'tok',
      taskClass: TIMEBILL_TASK_CLASSES.INVOICE_NARRATIVE,
      fetchImpl: fn,
    });

    const result = await provider.complete({
      systemPrompt: 'sys',
      userPrompt: 'draft it',
      maxTokens: 200,
      userId: 'user-9',
      clientRef: 'client-3',
    });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-vibe-task-class']).toBe('tb_invoice_narrative');
    expect(headers['x-vibe-user']).toBe('user-9');
    expect(headers['x-vibe-client']).toBe('client-3');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBeUndefined();
    expect(body.max_tokens).toBe(200);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });

    expect(result.providerId).toBe('vibe_router');
    expect(result.text).toBe('narrative text');
    expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 9 });
    expect(result.costEstimateCents).toBe(0); // router ledger owns cost
    expect(result.model).toBe('ollama/qwen3:14b');
  });

  // A1 — engagement attribution rides x-vibe-engagement; absent fields
  // must not emit headers (credential-ping parity: bare requests stay bare).
  it('sends x-vibe-engagement when engagementRef is set; omits absent attribution', async () => {
    const { calls, fn } = captureFetch(completionResponse);
    const provider = createVibeRouterProvider({
      baseUrl: 'http://router.test:8220',
      token: 'tok',
      taskClass: TIMEBILL_TASK_CLASSES.INVOICE_NARRATIVE,
      fetchImpl: fn,
    });

    await provider.complete({
      userPrompt: 'draft it',
      userId: 'user-9',
      clientRef: 'client-3',
      engagementRef: 'engagement-7',
    });
    const withRefs = calls[0]!.init.headers as Record<string, string>;
    expect(withRefs['x-vibe-engagement']).toBe('engagement-7');
    expect(withRefs['x-vibe-client']).toBe('client-3');

    await provider.complete({ userPrompt: 'ping' });
    const bare = calls[1]!.init.headers as Record<string, string>;
    expect(bare['x-vibe-user']).toBeUndefined();
    expect(bare['x-vibe-client']).toBeUndefined();
    expect(bare['x-vibe-engagement']).toBeUndefined();
    // Attribution must never leak into the prompt body.
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(JSON.stringify(body.messages)).not.toContain('client-3');
    expect(JSON.stringify(body.messages)).not.toContain('engagement-7');
  });

  it('router errors surface with the code — never a fallback', async () => {
    const { fn } = captureFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'policy_blocked', message: 'no policy' } }), {
          status: 403,
        }),
    );
    const provider = createVibeRouterProvider({
      baseUrl: 'http://router.test:8220',
      token: 'tok',
      taskClass: 'tb_invoice_narrative',
      fetchImpl: fn,
    });
    await expect(provider.complete({ userPrompt: 'x' })).rejects.toThrow(
      /Vibe AI Router: no policy \(policy_blocked\)/,
    );
  });
});

describe('registerTimeBillingTaskClasses', () => {
  it('declares the four classes in router mode only', async () => {
    const { calls, fn } = captureFetch(
      () => new Response(JSON.stringify({ registered: [] }), { status: 200 }),
    );
    registerTimeBillingTaskClasses({ fetchImpl: fn, maxAttempts: 1, log: () => {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls[0]!.url).toContain('/v1/task-classes/register');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.app).toBe('vibe-time-billing');
    // A8 — registration stamps the real package version (walk-up read at
    // runtime), never 'unknown', even without npm_package_version.
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.version).not.toBe('unknown');
    expect(body.classes.map((c: { key: string }) => c.key).sort()).toEqual([
      'tb_invoice_narrative',
      'timebill_file_naming',
      'timebill_practice_analytics',
      'timebill_support_chat',
    ]);

    process.env['VIBE_AI_MODE'] = 'direct';
    registerTimeBillingTaskClasses({ fetchImpl: fn, maxAttempts: 1, log: () => {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1);
  });
});
