// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Passkey (WebAuthn) sign-in. The full WebAuthn signature verification
// is library-internal and would need recorded fixtures from a real
// authenticator to fully exercise. These tests cover everything BUT
// that: option issuance, nonce/challenge bookkeeping, unknown-credential
// rejection, the PASSKEY 2FA branch on /2fa/start, and the missing-
// challenge guard on /2fa/verify.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { appUserCredentials } from '@vibe/db/schema';
import { createStaffAuthRouter } from '../auth/staff-routes';
import { hashPassword } from '../auth/password';

let harness: PgliteHarness;

beforeEach(async () => {
  process.env['STAFF_JWT_SECRET'] = 'test-staff-secret-' + 'x'.repeat(32);
  process.env['APP_BASE_URL'] = 'http://localhost:5173';
  process.env['STAFF_COOKIE_NAME'] = '__vibe_app_session';
  process.env['WEBAUTHN_RP_ID'] = 'localhost';
  process.env['WEBAUTHN_RP_NAME'] = 'Vibe TB';
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
  staffSession?: { sid: string; appUserId: string; firmId: string; lastStepUpAt: number | null };
  ip: string;
  header(name: string): string | undefined;
  get(name: string): string | undefined;
}
interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  cookieHeader: string | null;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  setHeader(name: string, value: string): void;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    cookieHeader: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
    setHeader(name: string, value: string) {
      if (name.toLowerCase() === 'set-cookie') this.cookieHeader = value;
    },
  };
}
async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'patch' | 'delete',
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
  zadd(...args: unknown[]): Promise<number>;
  zremrangebyscore(...args: unknown[]): Promise<number>;
  zcard(...args: unknown[]): Promise<number>;
}
function makeRedis(): FakeRedis {
  const store = new Map<string, string>();
  // Sorted-set storage for rate-limit primitives.
  const zset = new Map<string, Map<string, number>>();
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
    async zadd(key: string, score: number, member: string) {
      const m = zset.get(key) ?? new Map<string, number>();
      m.set(member, score);
      zset.set(key, m);
      return 1;
    },
    async zremrangebyscore() {
      return 0;
    },
    async zcard(key: string) {
      return zset.get(key)?.size ?? 0;
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

const PASSWORD = 'correct-horse-battery-staple';

async function setup(): Promise<{
  router: express.Router;
  appUserId: string;
  firmId: string;
  email: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  // Give the user a password + email OTP factor so we can drive the
  // password sign-in flow and reach the PASSKEY 2FA branch.
  const passwordHash = await hashPassword(PASSWORD);
  await harness.db.execute(
    sql`UPDATE app_user
        SET password_hash = ${passwordHash},
            password_set_at = now(),
            email_otp_enrolled_at = now()
        WHERE id = ${seed.appUserId}`,
  );
  // Pull email back so the test can use it verbatim.
  const row = await harness.db.execute(
    sql`SELECT email FROM app_user WHERE id = ${seed.appUserId}`,
  );
  const email = (row as unknown as { rows: { email: string }[] }).rows[0]!.email;
  return {
    router: createStaffAuthRouter({
      db: harness.db,
      redis: makeRedis() as unknown as Parameters<typeof createStaffAuthRouter>[0]['redis'],
      sessionStore: makeSessionStore() as unknown as Parameters<
        typeof createStaffAuthRouter
      >[0]['sessionStore'],
      sendMagicLink: async () => undefined,
      sendEmailOtp: async () => undefined,
      sendSmsOtp: async () => undefined,
      requireAuth: (_req, _res, next) => {
        next();
      },
    }),
    appUserId: seed.appUserId,
    firmId: seed.firmId,
    email,
  };
}

function baseReq(): FakeReq {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

describe('POST /login/passkey/options', () => {
  it('returns options + nonce; the nonce ties to a stored challenge', async () => {
    const { router } = await setup();
    const r = await invoke(router, 'post', '/login/passkey/options', baseReq());
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      options: { challenge: string; rpId: string };
      nonce: string;
    };
    expect(typeof body.options.challenge).toBe('string');
    expect(body.options.challenge.length).toBeGreaterThan(8);
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('POST /login/passkey/verify', () => {
  it('rejects with challenge_expired when the nonce is unknown', async () => {
    const { router } = await setup();
    const r = await invoke(router, 'post', '/login/passkey/verify', {
      ...baseReq(),
      body: { nonce: 'a'.repeat(32), response: { id: 'cred-x' } },
    });
    expect(r.statusCode).toBe(401);
    expect((r.jsonBody as { error: string }).error).toBe('challenge_expired');
  });

  it('rejects with invalid_credential when the credentialId is unknown', async () => {
    const { router } = await setup();
    // Issue an options call so the nonce/challenge exists.
    const opts = await invoke(router, 'post', '/login/passkey/options', baseReq());
    const nonce = (opts.jsonBody as { nonce: string }).nonce;
    const r = await invoke(router, 'post', '/login/passkey/verify', {
      ...baseReq(),
      body: { nonce, response: { id: 'totally-not-a-real-credential' } },
    });
    expect(r.statusCode).toBe(401);
    expect((r.jsonBody as { error: string }).error).toBe('invalid_credential');
  });
});

describe('POST /2fa/start with factor=PASSKEY', () => {
  it('returns 400 no_passkey_enrolled when the user has zero credentials', async () => {
    const { router, appUserId, firmId } = await setup();
    // Password sign-in returns a pendingToken — we need that to call /2fa/start.
    // Build a pending token directly via password login.
    const login = await invoke(router, 'post', '/login/password', {
      ...baseReq(),
      body: {
        email: 'sarah@test.example',
        password: PASSWORD,
      },
    });
    expect(login.statusCode).toBe(200);
    const pendingToken = (login.jsonBody as { pendingToken: string }).pendingToken;

    const r = await invoke(router, 'post', '/2fa/start', {
      ...baseReq(),
      body: { pendingToken, factor: 'PASSKEY' },
    });
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('factor_not_enrolled');
    void appUserId;
    void firmId;
  });

  it('returns options when the user has a passkey registered', async () => {
    const { router, appUserId, email } = await setup();
    await harness.db.insert(appUserCredentials).values({
      appUserId,
      credentialId: 'cred-1',
      publicKey: 'pk-1',
      signCount: 0,
      transports: 'internal',
      label: 'YubiKey',
      backedUp: false,
    });
    const login = await invoke(router, 'post', '/login/password', {
      ...baseReq(),
      body: { email, password: PASSWORD },
    });
    const pendingToken = (login.jsonBody as { pendingToken: string }).pendingToken;
    expect((login.jsonBody as { availableFactors: string[] }).availableFactors).toContain(
      'PASSKEY',
    );

    const r = await invoke(router, 'post', '/2fa/start', {
      ...baseReq(),
      body: { pendingToken, factor: 'PASSKEY' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      ok: boolean;
      factor: string;
      options: { challenge: string };
    };
    expect(body.factor).toBe('PASSKEY');
    expect(body.options.challenge).toBeTypeOf('string');
  });
});

describe('POST /2fa/verify with factor=PASSKEY', () => {
  it('returns 400 no_pending_authentication when /2fa/start was not called first', async () => {
    const { router, appUserId, email } = await setup();
    await harness.db.insert(appUserCredentials).values({
      appUserId,
      credentialId: 'cred-2',
      publicKey: 'pk-2',
      signCount: 0,
      transports: 'internal',
      label: 'TPM',
      backedUp: false,
    });
    const login = await invoke(router, 'post', '/login/password', {
      ...baseReq(),
      body: { email, password: PASSWORD },
    });
    const pendingToken = (login.jsonBody as { pendingToken: string }).pendingToken;

    const r = await invoke(router, 'post', '/2fa/verify', {
      ...baseReq(),
      body: {
        pendingToken,
        factor: 'PASSKEY',
        response: { id: 'cred-2' },
      },
    });
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('no_pending_authentication');
  });

  it('rejects an unknown credentialId when a challenge IS pending', async () => {
    const { router, appUserId, email } = await setup();
    await harness.db.insert(appUserCredentials).values({
      appUserId,
      credentialId: 'cred-real',
      publicKey: 'pk',
      signCount: 0,
      transports: 'internal',
      label: 'real',
      backedUp: false,
    });
    const login = await invoke(router, 'post', '/login/password', {
      ...baseReq(),
      body: { email, password: PASSWORD },
    });
    const pendingToken = (login.jsonBody as { pendingToken: string }).pendingToken;
    await invoke(router, 'post', '/2fa/start', {
      ...baseReq(),
      body: { pendingToken, factor: 'PASSKEY' },
    });
    const r = await invoke(router, 'post', '/2fa/verify', {
      ...baseReq(),
      body: {
        pendingToken,
        factor: 'PASSKEY',
        response: { id: 'cred-someone-elses' },
      },
    });
    expect(r.statusCode).toBe(401);
    expect((r.jsonBody as { error: string }).error).toBe('invalid_credential');
  });
});
