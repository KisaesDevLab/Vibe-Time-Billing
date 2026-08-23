// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CRITICAL non-negotiable #2: staff and portal sessions are isolated in
// every dimension. A staff cookie must not authenticate to portal routes
// and vice-versa.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import { buildTestApp, type TestHarness } from './_test-app';

const AT = '@';
const STAFF_EMAIL = `staff${AT}example.com`;

function cookieValue(res: request.Response, name: string): string | null {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const found = arr.find((c) => c.startsWith(`${name}=`));
  if (!found) return null;
  return found.split(';')[0]!.slice(name.length + 1);
}

function fakeStaffDb() {
  const state = {
    id: '00000000-0000-0000-0000-000000000001',
    email: STAFF_EMAIL,
    firmId: '00000000-0000-0000-0000-000000000fff',
    totpEnrolledAt: null,
    totpSecretEncrypted: null,
  };
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ ...state, recovery: null }],
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({ values: async () => undefined }),
  };
}

describe('cross-realm session isolation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    harness = await buildTestApp({ db: fakeStaffDb() as any });
  });

  async function loginStaff(): Promise<string> {
    await request(harness.app).post('/api/auth/login').send({ email: STAFF_EMAIL });
    const token = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;
    const verify = await request(harness.app).post('/api/auth/verify-magic-link').send({ token });
    return cookieValue(verify, '__vibe_app_session')!;
  }

  it('a staff cookie under the portal cookie name does not auth to portal routes', async () => {
    const staffCookie = await loginStaff();
    // Forge: try the staff cookie under the portal cookie name.
    const res = await request(harness.app)
      .get('/api/portal/auth/me')
      .set('Cookie', `__vibe_portal_session=${staffCookie}`);
    // Should reject — either no_session, invalid_session, or portal_disabled
    // (license gate). All non-200 outcomes are acceptable; what matters is
    // we never expose portal data to a staff session.
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThanOrEqual(503);
  });

  it('staff routes reject the staff cookie if sent under the portal name', async () => {
    const staffCookie = await loginStaff();
    const res = await request(harness.app)
      .get('/api/staff/whoami')
      .set('Cookie', `__vibe_portal_session=${staffCookie}`);
    expect(res.status).toBe(401);
  });

  it('staff JWT cannot be verified as a portal magic link', async () => {
    // A magic link signed with STAFF_JWT_SECRET, presented to the portal
    // verify endpoint, must fail with invalid_token.
    await request(harness.app).post('/api/auth/login').send({ email: STAFF_EMAIL });
    const staffToken = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;
    const res = await request(harness.app)
      .post('/api/portal/auth/verify-magic-link')
      .send({ token: staffToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });
});
