// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// RBAC gating on admin endpoints. Uses fakeUserRoles override on the app
// builder so we don't depend on the DB for role resolution.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import { buildTestApp, type TestHarness } from './_test-app';

const AT = '@';
const EMAIL = `boss${AT}example.com`;

function fakeDb() {
  const state = {
    id: '00000000-0000-0000-0000-000000000001',
    email: EMAIL,
    firmId: '00000000-0000-0000-0000-000000000fff',
    totpEnrolledAt: null,
    totpSecretEncrypted: null,
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select: () => ({
      from: () => ({
        // Awaiting .where() directly (0147 loadOverrides) resolves to an
        // empty list; chaining .limit() (user lookup) returns the row.
        where: () =>
          Object.assign(Promise.resolve([]), {
            limit: async () => [{ ...state, recovery: null }],
          }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'new-id' }] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
}

function cookieValue(res: request.Response, name: string): string | null {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const found = arr.find((c) => c.startsWith(`${name}=`));
  if (!found) return null;
  return found.split(';')[0]!.slice(name.length + 1);
}

async function login(harness: TestHarness) {
  await request(harness.app).post('/api/auth/login').send({ email: EMAIL });
  const token = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;
  const verify = await request(harness.app).post('/api/auth/verify-magic-link').send({ token });
  return cookieValue(verify, '__vibe_app_session')!;
}

describe('RBAC on admin endpoints', () => {
  let harness: TestHarness;
  const userId = '00000000-0000-0000-0000-000000000001';

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    harness = await buildTestApp({ db: fakeDb() as any });
  });

  it('staff role cannot read firm settings (403)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    harness = await buildTestApp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeDb() as any,
      fakeUserRoles: new Map([[userId, ['staff']]]),
    });
    const cookie = await login(harness);
    const res = await request(harness.app)
      .get('/api/staff/admin/firm-settings')
      .set('Cookie', `__vibe_app_session=${cookie}`);
    expect(res.status).toBe(403);
    expect(res.body.required).toBe('firm:settings:read');
  });

  it('admin role can read firm settings (200)', async () => {
    harness = await buildTestApp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeDb() as any,
      fakeUserRoles: new Map([[userId, ['admin']]]),
    });
    const cookie = await login(harness);
    const res = await request(harness.app)
      .get('/api/staff/admin/firm-settings')
      .set('Cookie', `__vibe_app_session=${cookie}`);
    expect(res.status).toBe(200);
  });

  it('partner can read but not write firm settings', async () => {
    harness = await buildTestApp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeDb() as any,
      fakeUserRoles: new Map([[userId, ['partner']]]),
    });
    const cookie = await login(harness);
    const read = await request(harness.app)
      .get('/api/staff/admin/firm-settings')
      .set('Cookie', `__vibe_app_session=${cookie}`);
    expect(read.status).toBe(200);

    // Need a CSRF token for the patch (CSRF middleware applies). Get it via /me.
    const me = await request(harness.app)
      .get('/api/auth/me')
      .set('Cookie', `__vibe_app_session=${cookie}`);
    const csrf = me.body.csrfToken;

    const write = await request(harness.app)
      .patch('/api/staff/admin/firm-settings')
      .set('Cookie', `__vibe_app_session=${cookie}`)
      .set('X-CSRF-Token', csrf)
      .send({ portalEnabled: false });
    expect(write.status).toBe(403);
    expect(write.body.required).toBe('firm:settings:write');
  });

  it('admin can patch firm settings with valid CSRF', async () => {
    harness = await buildTestApp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeDb() as any,
      fakeUserRoles: new Map([[userId, ['admin']]]),
    });
    const cookie = await login(harness);
    const me = await request(harness.app)
      .get('/api/auth/me')
      .set('Cookie', `__vibe_app_session=${cookie}`);
    const csrf = me.body.csrfToken;

    const write = await request(harness.app)
      .patch('/api/staff/admin/firm-settings')
      .set('Cookie', `__vibe_app_session=${cookie}`)
      .set('X-CSRF-Token', csrf)
      .send({ portalEnabled: false });
    expect(write.status).toBe(200);
  });

  it('CSRF token required on mutating admin endpoints', async () => {
    harness = await buildTestApp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeDb() as any,
      fakeUserRoles: new Map([[userId, ['admin']]]),
    });
    const cookie = await login(harness);
    const noCsrf = await request(harness.app)
      .patch('/api/staff/admin/firm-settings')
      .set('Cookie', `__vibe_app_session=${cookie}`)
      .send({ portalEnabled: false });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error).toBe('csrf_mismatch');
  });
});
