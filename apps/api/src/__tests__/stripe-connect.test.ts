// SPDX-License-Identifier: Elastic-2.0
//
// P08 — Stripe Connect OAuth route tests.
//
// We stub the StripeConnectClient so tests never hit the live OAuth
// endpoint. Pure URL building is tested separately in
// `stripe-connect-oauth.test.ts`.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { firmSettingsProposals } from '@vibe/db/schema';
import { createStripeConnectRouter, type StripeConnectClient } from '../stripe-connect/routes';

let harness: PgliteHarness;
let redis: Redis;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

afterEach(async () => {
  await harness.close();
  await redis.quit();
});

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
function makeReq(o: { firmId: string; appUserId: string } & Partial<FakeReq>): FakeReq {
  return {
    body: o.body ?? {},
    params: o.params ?? {},
    query: o.query ?? {},
    staffSession: { firmId: o.firmId, appUserId: o.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}
function makeRes(): FakeRes {
  const r: FakeRes = {
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
  return r;
}
async function invoke(
  router: ReturnType<typeof createStripeConnectRouter>,
  method: 'get' | 'post',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const route = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return route.path === path && route.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method.toUpperCase()} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

function fakeClient(overrides: Partial<StripeConnectClient> = {}): StripeConnectClient {
  return {
    exchangeCode: async (code) => ({
      stripeUserId: `acct_${code}`,
      stripePublishableKey: `pk_test_${code}`,
      scope: 'read_write',
      livemode: false,
      raw: { code },
    }),
    deauthorize: async () => undefined,
    fetchAccount: async (id) => ({
      id,
      email: 'firm@example.com',
      businessProfileName: 'Smith CPAs',
      capabilities: { card_payments: 'active', us_bank_account_ach_payments: 'pending' },
      defaultCurrency: 'usd',
      payoutsEnabled: true,
      chargesEnabled: true,
      detailsSubmitted: true,
    }),
    ...overrides,
  };
}

async function setup(): Promise<{
  firmId: string;
  appUserId: string;
  router: ReturnType<typeof createStripeConnectRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const router = createStripeConnectRouter({
    db: harness.db,
    redis,
    fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
    config: {
      clientId: 'ca_test_platform',
      secretKey: 'sk_test_platform',
      redirectUri: 'https://app.firm.example/admin/payments',
    },
    client: fakeClient(),
  });
  return { firmId: seed.firmId, appUserId: seed.appUserId, router };
}

describe('P08 — /authorize-url', () => {
  it('returns a URL containing client_id + state, persists state in redis', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/authorize-url', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { url: string; state: string };
    expect(body.url).toContain('connect.stripe.com/oauth/authorize');
    expect(body.url).toContain('client_id=ca_test_platform');
    expect(body.url).toContain(`state=${body.state}`);
    expect(body.state.startsWith(`${f.firmId}.`)).toBe(true);
    const stored = await redis.get(`sc:state:${body.state}`);
    expect(stored).toBe(f.firmId);
  });

  it('503 if Stripe Connect not configured', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createStripeConnectRouter({
      db: harness.db,
      redis,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
      config: { clientId: null, secretKey: null, redirectUri: null },
    });
    const r = await invoke(router, 'post', '/authorize-url', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
    });
    expect(r.statusCode).toBe(503);
  });
});

describe('P08 — /callback', () => {
  it('exchanges code, persists stripe_account_id, deletes state', async () => {
    const f = await setup();
    // First mint a state.
    const authRes = await invoke(f.router, 'post', '/authorize-url', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    const state = (authRes.jsonBody as { state: string }).state;
    const cb = await invoke(f.router, 'post', '/callback', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        body: { code: 'authcode-abc', state },
      }),
    });
    expect(cb.statusCode).toBe(200);
    const body = cb.jsonBody as { stripeAccountId: string };
    expect(body.stripeAccountId).toBe('acct_authcode-abc');
    // State consumed.
    expect(await redis.get(`sc:state:${state}`)).toBeNull();
    // Persisted.
    const [row] = await harness.db
      .select()
      .from(firmSettingsProposals)
      .where(eq(firmSettingsProposals.firmId, f.firmId));
    expect(row!.stripeAccountId).toBe('acct_authcode-abc');
    expect(row!.stripePublishableKey).toBe('pk_test_authcode-abc');
    expect(row!.stripeConnectedAt).not.toBeNull();
  });

  it('rejects unknown state', async () => {
    const f = await setup();
    const cb = await invoke(f.router, 'post', '/callback', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        body: { code: 'x', state: 'never-stored' },
      }),
    });
    expect(cb.statusCode).toBe(400);
    expect((cb.jsonBody as { error: string }).error).toBe('invalid_state');
  });

  it('rejects state issued by a different firm', async () => {
    const f = await setup();
    // Manually plant a state for some other firm.
    const otherFirmId = '99999999-9999-9999-9999-999999999999';
    const fakeState = `${otherFirmId}.deadbeefdeadbeef`;
    await redis.set(`sc:state:${fakeState}`, otherFirmId, 'EX', 60);
    const cb = await invoke(f.router, 'post', '/callback', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        body: { code: 'x', state: fakeState },
      }),
    });
    expect(cb.statusCode).toBe(403);
    expect((cb.jsonBody as { error: string }).error).toBe('state_firm_mismatch');
  });

  it('502 if stripe exchange fails', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createStripeConnectRouter({
      db: harness.db,
      redis,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
      config: {
        clientId: 'ca_test_platform',
        secretKey: 'sk_test_platform',
        redirectUri: null,
      },
      client: fakeClient({
        exchangeCode: async () => {
          throw new Error('stripe down');
        },
      }),
    });
    const authRes = await invoke(router, 'post', '/authorize-url', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
    });
    const state = (authRes.jsonBody as { state: string }).state;
    const cb = await invoke(router, 'post', '/callback', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: { code: 'x', state },
      }),
    });
    expect(cb.statusCode).toBe(502);
  });
});

describe('P08 — /disconnect', () => {
  it('deauthorizes + clears local state', async () => {
    const f = await setup();
    // Connect first.
    const auth = await invoke(f.router, 'post', '/authorize-url', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    await invoke(f.router, 'post', '/callback', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        body: { code: 'c', state: (auth.jsonBody as { state: string }).state },
      }),
    });
    const dis = await invoke(f.router, 'post', '/disconnect', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect(dis.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(firmSettingsProposals)
      .where(eq(firmSettingsProposals.firmId, f.firmId));
    expect(row!.stripeAccountId).toBeNull();
    expect(row!.stripeDisconnectedAt).not.toBeNull();
  });

  it('404 when not connected', async () => {
    const f = await setup();
    const dis = await invoke(f.router, 'post', '/disconnect', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect(dis.statusCode).toBe(404);
  });
});

describe('P08 — /account-status', () => {
  it('returns connected=false when not configured', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createStripeConnectRouter({
      db: harness.db,
      redis,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
      config: { clientId: null, secretKey: null, redirectUri: null },
    });
    const r = await invoke(router, 'get', '/account-status', {
      ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { connected: boolean; configured: boolean };
    expect(body.connected).toBe(false);
    expect(body.configured).toBe(false);
  });

  it('returns connected=true + capabilities after refresh', async () => {
    const f = await setup();
    const auth = await invoke(f.router, 'post', '/authorize-url', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    await invoke(f.router, 'post', '/callback', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        body: { code: 'c', state: (auth.jsonBody as { state: string }).state },
      }),
    });
    const status = await invoke(f.router, 'get', '/account-status', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        query: { refresh: 'true' },
      }),
    });
    expect(status.statusCode).toBe(200);
    const body = status.jsonBody as {
      connected: boolean;
      live: { capabilities: Record<string, string>; chargesEnabled: boolean };
    };
    expect(body.connected).toBe(true);
    expect(body.live.capabilities.card_payments).toBe('active');
    expect(body.live.chargesEnabled).toBe(true);
  });
});
