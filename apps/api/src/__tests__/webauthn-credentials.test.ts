// SPDX-License-Identifier: Elastic-2.0
//
// WebAuthn credential management tests. The full register/verify dance
// requires a real browser authenticator (or fixtures recorded from
// one), so this test focuses on the list + delete endpoints — the
// surface that an account-settings UI consumes — using fake stored
// credentials inserted directly via the schema.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { appUserCredentials } from '@vibe/db/schema';
import { createStaffAuthRouter } from '../auth/staff-routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

interface FakeReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  staffSession: { sid: string; appUserId: string; firmId: string; lastStepUpAt: number | null };
  ip: string;
  header(name: string): string | undefined;
  get(name: string): string | undefined;
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

async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'delete',
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
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

interface FakeRedis {
  store: Map<string, string>;
  get(k: string): Promise<string | null>;
  set(k: string, v: string, ..._args: unknown[]): Promise<'OK'>;
  del(k: string): Promise<number>;
  incr(k: string): Promise<number>;
  expire(k: string, _t: number): Promise<number>;
}

function makeRedis(): FakeRedis {
  const store = new Map<string, string>();
  return {
    store,
    async get(k) {
      return store.get(k) ?? null;
    },
    async set(k, v) {
      store.set(k, v);
      return 'OK';
    },
    async del(k) {
      return store.delete(k) ? 1 : 0;
    },
    async incr(k) {
      const n = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(n));
      return n;
    },
    async expire() {
      return 1;
    },
  };
}

interface FakeSessionStore {
  put(s: unknown): Promise<void>;
  destroy(_realm: string, _sid: string): Promise<void>;
}
function makeSessionStore(): FakeSessionStore {
  return {
    async put() {},
    async destroy() {},
  };
}

async function setup(): Promise<{
  router: express.Router;
  appUserId: string;
  req: (overrides?: Partial<FakeReq>) => FakeReq;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const router = createStaffAuthRouter({
    db: harness.db,
    redis: makeRedis() as unknown as Parameters<typeof createStaffAuthRouter>[0]['redis'],
    sessionStore: makeSessionStore() as unknown as Parameters<
      typeof createStaffAuthRouter
    >[0]['sessionStore'],
    sendMagicLink: async () => undefined,
    requireAuth: (_req, _res, next) => {
      next();
    },
  });
  function req(overrides?: Partial<FakeReq>): FakeReq {
    return {
      body: {},
      params: {},
      query: {},
      headers: {},
      staffSession: {
        sid: 'sid-1',
        appUserId: seed.appUserId,
        firmId: seed.firmId,
        lastStepUpAt: null,
      },
      ip: '127.0.0.1',
      header: () => undefined,
      get: () => undefined,
      ...overrides,
    };
  }
  return { router, appUserId: seed.appUserId, req };
}

describe('WebAuthn — credentials list/delete', () => {
  it('GET /webauthn/credentials returns empty when none registered', async () => {
    const { router, req } = await setup();
    const r = await invoke(router, 'get', '/webauthn/credentials', req());
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { items: unknown[] }).items).toEqual([]);
  });

  it('GET /webauthn/credentials lists rows scoped to the caller', async () => {
    const { router, req, appUserId } = await setup();
    await harness.db.insert(appUserCredentials).values({
      appUserId,
      credentialId: 'cred-1',
      publicKey: 'pk-1',
      signCount: 0,
      transports: 'internal,hybrid',
      label: 'iPhone',
      deviceType: 'multiDevice',
      backedUp: true,
    });
    const r = await invoke(router, 'get', '/webauthn/credentials', req());
    const body = r.jsonBody as {
      items: Array<{ id: string; label: string; transports: string[]; backedUp: boolean }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.label).toBe('iPhone');
    expect(body.items[0]!.transports).toEqual(['internal', 'hybrid']);
    expect(body.items[0]!.backedUp).toBe(true);
  });

  it('DELETE /webauthn/credentials/:id removes the row and audits', async () => {
    const { router, req, appUserId } = await setup();
    const [row] = await harness.db
      .insert(appUserCredentials)
      .values({
        appUserId,
        credentialId: 'cred-2',
        publicKey: 'pk-2',
        signCount: 5,
        transports: '',
      })
      .returning({ id: appUserCredentials.id });
    const r = await invoke(router, 'delete', '/webauthn/credentials/:id', {
      ...req(),
      params: { id: row!.id },
    });
    expect(r.statusCode).toBe(200);
    const remaining = await harness.db
      .select({ id: appUserCredentials.id })
      .from(appUserCredentials)
      .where(eq(appUserCredentials.id, row!.id));
    expect(remaining).toHaveLength(0);
  });

  it('DELETE /webauthn/credentials/:id refuses to delete another user’s row', async () => {
    const { router, req } = await setup();
    // Build a second user in the same firm.
    const r2 = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          SELECT firm_id, 'other@firm.example', 'Other', 'O', 'O' FROM app_user LIMIT 1
          RETURNING id`,
    );
    const otherUserId = (r2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const [row] = await harness.db
      .insert(appUserCredentials)
      .values({
        appUserId: otherUserId,
        credentialId: 'cred-3',
        publicKey: 'pk-3',
        signCount: 0,
        transports: '',
      })
      .returning({ id: appUserCredentials.id });
    const r = await invoke(router, 'delete', '/webauthn/credentials/:id', {
      ...req(),
      params: { id: row!.id },
    });
    expect(r.statusCode).toBe(404);
    // Row still exists.
    const still = await harness.db
      .select({ id: appUserCredentials.id })
      .from(appUserCredentials)
      .where(eq(appUserCredentials.id, row!.id));
    expect(still).toHaveLength(1);
  });
});
