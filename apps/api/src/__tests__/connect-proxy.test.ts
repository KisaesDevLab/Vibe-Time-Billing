// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Connect placeholder routes — verifies all four upstream-proxy
// endpoints (enroll, subscriptions, destinations, events/dry-run)
// share the same 503-not-configured / 502-upstream-unreachable /
// status-mirroring behavior.

import { describe, expect, it } from 'vitest';
import type express from 'express';

import { createConnectRouter } from '../connect/routes';

interface FakeReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  get(_h: string): string | undefined;
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
function invoke(
  router: express.Router,
  method: 'get' | 'post',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  return (handler as (req: unknown, res: unknown) => Promise<void>)(req, res).then(() => res);
}

function baseReq(): FakeReq {
  return {
    body: {},
    params: {},
    query: {},
    staffSession: { firmId: 'firm-1', appUserId: 'user-1' },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}

describe('Connect placeholder routes', () => {
  it('all four return 503 not_configured when env is missing', async () => {
    const router = createConnectRouter({
      db: null,
      fakeUserRoles: new Map([['user-1', ['admin']]]),
      connectBaseUrl: null,
      connectApiKey: null,
    });
    for (const [method, path] of [
      ['post', '/enroll'],
      ['post', '/subscriptions'],
      ['get', '/destinations'],
      ['post', '/events/dry-run'],
    ] as const) {
      const r = await invoke(router, method, path, baseReq());
      expect(r.statusCode).toBe(503);
      expect((r.jsonBody as { error: string }).error).toBe('not_configured');
    }
  });

  it('mirrors upstream status + body when wired', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true, echo: init?.body }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const router = createConnectRouter({
      db: null,
      fakeUserRoles: new Map([['user-1', ['admin']]]),
      connectBaseUrl: 'https://connect.example.com',
      connectApiKey: 'tok-xyz',
      fetchImpl: fakeFetch,
    });
    const r = await invoke(router, 'post', '/subscriptions', {
      ...baseReq(),
      body: { eventTypes: ['invoice.paid'], destinationId: 'slack-1' },
    });
    expect(r.statusCode).toBe(201);
    expect((r.jsonBody as { ok: boolean }).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://connect.example.com/subscriptions');
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-xyz');
    // firmId is included in the proxied body so upstream can scope.
    expect(String(calls[0]!.init?.body)).toContain('firm-1');
  });

  it('returns 502 when upstream throws', async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error('network down');
    };
    const router = createConnectRouter({
      db: null,
      fakeUserRoles: new Map([['user-1', ['admin']]]),
      connectBaseUrl: 'https://connect.example.com',
      connectApiKey: 'tok-xyz',
      fetchImpl: fakeFetch,
    });
    const r = await invoke(router, 'get', '/destinations', baseReq());
    expect(r.statusCode).toBe(502);
    expect((r.jsonBody as { error: string }).error).toBe('upstream_unreachable');
  });

  it('GET /destinations passes firmId as a query param', async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const router = createConnectRouter({
      db: null,
      fakeUserRoles: new Map([['user-1', ['admin']]]),
      connectBaseUrl: 'https://connect.example.com',
      connectApiKey: 'tok-xyz',
      fetchImpl: fakeFetch,
    });
    const r = await invoke(router, 'get', '/destinations', baseReq());
    expect(r.statusCode).toBe(200);
    expect(calls[0]).toBe('https://connect.example.com/destinations?firmId=firm-1');
  });
});
