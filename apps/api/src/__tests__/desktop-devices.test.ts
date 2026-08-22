// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-3 — desktop device credentials: enroll → refresh mints a session and
// rotates the token → replay of the old token fails → list/revoke.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type express from 'express';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';

import { appUsers } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetConfigForTests } from '../config';
import { createSessionStore } from '../auth/session-store';
import { createDesktopAuthRouter, createDesktopDevicesRouter } from '../auth/desktop-devices';

let h: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let redis: Redis;

beforeEach(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['STAFF_JWT_SECRET'] = 'test-staff-secret-' + 'x'.repeat(20);
  process.env['PORTAL_JWT_SECRET'] = 'test-portal-secret-' + 'x'.repeat(20);
  process.env['DATABASE_URL'] = 'postgresql://vibe:vibe@localhost:5432/vibe_tb_test';
  resetConfigForTests();
  h = await buildPgliteHarness();
  seed = await seedMinimalFirm(h.db);
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});
afterEach(async () => {
  await h.close();
});

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  cookies: string[];
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  append(k: string, v: string): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    cookies: [],
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
    append(_k, v) {
      this.cookies.push(v);
      return this;
    },
  };
}
async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'delete',
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
  type Handle = (rq: unknown, rs: unknown, nx?: () => void) => unknown;
  const chain = (layer.route as unknown as { stack: { handle: Handle }[] }).stack;
  for (let i = 0; i < chain.length - 1; i++) {
    let advanced = false;
    await chain[i]!.handle(req, res, () => {
      advanced = true;
    });
    if (!advanced) return res;
  }
  await chain[chain.length - 1]!.handle(req, res);
  return res;
}
function authedReq(body: unknown, params: Record<string, string> = {}): Record<string, unknown> {
  return {
    body: body ?? {},
    params,
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
  };
}
function anonReq(body: unknown): Record<string, unknown> {
  return { body, params: {}, query: {}, headers: {}, ip: '127.0.0.1', header: () => undefined };
}

function routers(role: 'partner' | 'admin' = 'partner') {
  const sessionStore = createSessionStore(redis);
  const base = {
    db: h.db,
    redis,
    sessionStore,
    fakeUserRoles: new Map([[seed.appUserId, [role]]]),
  };
  return {
    auth: createDesktopAuthRouter({
      ...base,
      requireAuth: (_req, _res, next) => next(),
    }),
    devices: createDesktopDevicesRouter(base),
    sessionStore,
  };
}

const DEVICE = { deviceId: 'dev_abcdef123456', deviceName: 'KURT-PC' };

describe('desktop devices', () => {
  it('enroll → refresh mints a cookie session and rotates the token', async () => {
    const r = routers();
    const enrolled = await invoke(r.auth, 'post', '/desktop/enroll', authedReq(DEVICE));
    expect(enrolled.statusCode).toBe(201);
    const { refreshToken } = enrolled.jsonBody as { refreshToken: string };
    expect(refreshToken.length).toBeGreaterThan(30);

    const refreshed = await invoke(
      r.auth,
      'post',
      '/desktop/refresh',
      anonReq({ deviceId: DEVICE.deviceId, refreshToken }),
    );
    expect(refreshed.statusCode).toBe(200);
    const body = refreshed.jsonBody as { csrfToken: string; refreshToken: string };
    expect(body.csrfToken).toBeTruthy();
    expect(body.refreshToken).not.toBe(refreshToken);
    expect(refreshed.cookies.some((c) => c.startsWith('__vibe_app_session='))).toBe(true);
    const sid = refreshed.cookies[0]!.split(';')[0]!.split('=')[1]!;
    const session = await r.sessionStore.get('staff', sid);
    expect(session?.realm).toBe('staff');
    expect((session as { lastStepUpAt: number | null }).lastStepUpAt).toBeNull();

    // Replay of the rotated token is refused.
    const replay = await invoke(
      r.auth,
      'post',
      '/desktop/refresh',
      anonReq({ deviceId: DEVICE.deviceId, refreshToken }),
    );
    expect(replay.statusCode).toBe(401);

    // The rotated token works.
    const again = await invoke(
      r.auth,
      'post',
      '/desktop/refresh',
      anonReq({ deviceId: DEVICE.deviceId, refreshToken: body.refreshToken }),
    );
    expect(again.statusCode).toBe(200);
  });

  it('rejects a deviceId mismatch', async () => {
    const r = routers();
    const enrolled = await invoke(r.auth, 'post', '/desktop/enroll', authedReq(DEVICE));
    const { refreshToken } = enrolled.jsonBody as { refreshToken: string };
    const bad = await invoke(
      r.auth,
      'post',
      '/desktop/refresh',
      anonReq({ deviceId: 'dev_other_device', refreshToken }),
    );
    expect(bad.statusCode).toBe(401);
  });

  it('lists and revokes own devices', async () => {
    const r = routers();
    await invoke(r.auth, 'post', '/desktop/enroll', authedReq(DEVICE));
    await invoke(
      r.auth,
      'post',
      '/desktop/enroll',
      authedReq({ deviceId: 'dev_second_machine', deviceName: 'LAPTOP' }),
    );
    const list = await invoke(r.devices, 'get', '/', authedReq({}));
    const items = (list.jsonBody as { items: { id: string; deviceName: string }[] }).items;
    expect(items.map((i) => i.deviceName).sort()).toEqual(['KURT-PC', 'LAPTOP']);

    const del = await invoke(r.devices, 'delete', '/:id', authedReq({}, { id: items[0]!.id }));
    expect(del.statusCode).toBe(200);
    const after = await invoke(r.devices, 'get', '/', authedReq({}));
    expect((after.jsonBody as { items: unknown[] }).items).toHaveLength(1);
  });

  it('re-enrolling the same device replaces its credential', async () => {
    const r = routers();
    const a = await invoke(r.auth, 'post', '/desktop/enroll', authedReq(DEVICE));
    const b = await invoke(r.auth, 'post', '/desktop/enroll', authedReq(DEVICE));
    const tokA = (a.jsonBody as { refreshToken: string }).refreshToken;
    const tokB = (b.jsonBody as { refreshToken: string }).refreshToken;
    const list = await invoke(r.devices, 'get', '/', authedReq({}));
    expect((list.jsonBody as { items: unknown[] }).items).toHaveLength(1);
    const oldRefresh = await invoke(
      r.auth,
      'post',
      '/desktop/refresh',
      anonReq({ deviceId: DEVICE.deviceId, refreshToken: tokA }),
    );
    expect(oldRefresh.statusCode).toBe(401);
    const newRefresh = await invoke(
      r.auth,
      'post',
      '/desktop/refresh',
      anonReq({ deviceId: DEVICE.deviceId, refreshToken: tokB }),
    );
    expect(newRefresh.statusCode).toBe(200);
  });

  it('an archived user cannot refresh and loses all devices', async () => {
    const r = routers();
    const enrolled = await invoke(r.auth, 'post', '/desktop/enroll', authedReq(DEVICE));
    const { refreshToken } = enrolled.jsonBody as { refreshToken: string };
    await h.db.update(appUsers).set({ status: 'ARCHIVED' }).where(eq(appUsers.id, seed.appUserId));
    const res = await invoke(
      r.auth,
      'post',
      '/desktop/refresh',
      anonReq({ deviceId: DEVICE.deviceId, refreshToken }),
    );
    expect(res.statusCode).toBe(401);
    const list = await invoke(r.devices, 'get', '/', authedReq({}));
    expect((list.jsonBody as { items: unknown[] }).items).toHaveLength(0);
  });

  it('admin can list + revoke another user in the same firm; partner cannot', async () => {
    const partner = routers('partner');
    const denied = await invoke(
      partner.devices,
      'get',
      '/user/:appUserId',
      authedReq({}, { appUserId: seed.appUserId }),
    );
    expect(denied.statusCode).toBe(403);
    const r = routers('admin');
    await invoke(r.auth, 'post', '/desktop/enroll', authedReq(DEVICE));
    const list = await invoke(
      r.devices,
      'get',
      '/user/:appUserId',
      authedReq({}, { appUserId: seed.appUserId }),
    );
    expect(list.statusCode).toBe(200);
    expect((list.jsonBody as { items: unknown[] }).items).toHaveLength(1);
    const rev = await invoke(
      r.devices,
      'delete',
      '/user/:appUserId',
      authedReq({}, { appUserId: seed.appUserId }),
    );
    expect((rev.jsonBody as { revoked: number }).revoked).toBe(1);
  });
});
