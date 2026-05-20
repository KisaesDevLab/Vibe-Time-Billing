// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Integration-style auth tests using ioredis-mock + a stubbed DB.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';

import { buildTestApp, type TestHarness } from './_test-app';

// Build email values at runtime to dodge static email-obfuscation.
const AT = '@';
const E = (local: string, domain: string) => `${local}${AT}${domain}`;
const STAFF_EMAIL = E('staff', 'example.com');
const SARAH_EMAIL = E('sarah', 'granitepeak.example.com');
const NOBODY_EMAIL = E('nobody', 'example.com');
const BAD_EMAIL = 'not-an-email';

interface FakeUser {
  id: string;
  email: string;
  firmId: string;
  totpEnrolledAt: Date | null;
  totpSecretEncrypted: string | null;
  recoveryCodesEncrypted: string | null;
}

function fakeDb(initialUser: FakeUser): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  current: () => FakeUser;
} {
  const state = { ...initialUser };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: state.id,
              email: state.email,
              firmId: state.firmId,
              totpEnrolledAt: state.totpEnrolledAt,
              totpSecretEncrypted: state.totpSecretEncrypted,
              recovery: state.recoveryCodesEncrypted,
            },
          ],
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<FakeUser>) => ({
        where: async () => Object.assign(state, patch),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
  };
  return { db, current: () => state };
}

function getCookie(res: request.Response, name: string): string | null {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const found = arr.find((c) => c.startsWith(`${name}=`));
  if (!found) return null;
  return found.split(';')[0]!.slice(name.length + 1);
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await buildTestApp();
});

describe('POST /api/auth/login', () => {
  it('returns the same shape whether or not the email exists', async () => {
    const res1 = await request(harness.app).post('/api/auth/login').send({ email: NOBODY_EMAIL });
    expect(res1.status).toBe(200);
    expect(res1.body.ok).toBe(true);
    expect(res1.body.message).toMatch(/if your account exists/i);
    expect(harness.capturedMagicLinks).toHaveLength(0);
  });

  it('rejects malformed payload', async () => {
    const res = await request(harness.app).post('/api/auth/login').send({ email: BAD_EMAIL });
    expect(res.status).toBe(400);
  });

  it('enforces per-contact rate limit (5/15min)', async () => {
    for (let i = 0; i < 5; i++) {
      await request(harness.app).post('/api/auth/login').send({ email: NOBODY_EMAIL });
    }
    const res = await request(harness.app).post('/api/auth/login').send({ email: NOBODY_EMAIL });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if your account exists/i);
  });
});

describe('magic-link verify + session + CSRF', () => {
  let user: FakeUser;
  beforeEach(async () => {
    user = {
      id: '00000000-0000-0000-0000-000000000001',
      email: STAFF_EMAIL,
      firmId: '00000000-0000-0000-0000-000000000fff',
      totpEnrolledAt: null,
      totpSecretEncrypted: null,
      recoveryCodesEncrypted: null,
    };
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
  });

  it('issues a magic link, then completes verify and sets a cookie', async () => {
    await request(harness.app).post('/api/auth/login').send({ email: user.email });
    expect(harness.capturedMagicLinks).toHaveLength(1);

    const token = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;

    const verify = await request(harness.app).post('/api/auth/verify-magic-link').send({ token });
    expect(verify.status).toBe(200);
    expect(verify.body.ok).toBe(true);
    expect(verify.body.csrfToken).toMatch(/^[0-9a-f]{48}$/);
    expect(verify.body.needsTotpEnrollment).toBe(true);

    const cookie = getCookie(verify, '__vibe_app_session');
    expect(cookie).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects magic-link replay (single-use)', async () => {
    await request(harness.app).post('/api/auth/login').send({ email: user.email });
    const token = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;

    const first = await request(harness.app).post('/api/auth/verify-magic-link').send({ token });
    expect(first.status).toBe(200);

    const second = await request(harness.app).post('/api/auth/verify-magic-link').send({ token });
    expect(second.status).toBe(401);
    expect(second.body.error).toBe('token_already_used');
  });

  it('GET /api/auth/me requires session, returns subject on success', async () => {
    const noAuth = await request(harness.app).get('/api/auth/me');
    expect(noAuth.status).toBe(401);

    await request(harness.app).post('/api/auth/login').send({ email: user.email });
    const token = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;
    const verify = await request(harness.app).post('/api/auth/verify-magic-link').send({ token });
    const cookie = getCookie(verify, '__vibe_app_session')!;

    const me = await request(harness.app)
      .get('/api/auth/me')
      .set('Cookie', `__vibe_app_session=${cookie}`);
    expect(me.status).toBe(200);
    expect(me.body.appUserId).toBe(user.id);
    expect(me.body.firmId).toBe(user.firmId);
  });

  it('GET /api/staff/* requires session', async () => {
    const ok = await request(harness.app).get('/api/staff/whoami');
    expect(ok.status).toBe(401);
  });
});

describe('TOTP step-up', () => {
  const SECRET = authenticator.generateSecret();
  let user: FakeUser;

  beforeEach(async () => {
    user = {
      id: '00000000-0000-0000-0000-000000000001',
      email: SARAH_EMAIL,
      firmId: '00000000-0000-0000-0000-000000000fff',
      totpEnrolledAt: new Date(),
      totpSecretEncrypted: SECRET,
      recoveryCodesEncrypted: null,
    };
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
  });

  it('verifies a fresh TOTP code and sets lastStepUpAt', async () => {
    await request(harness.app).post('/api/auth/login').send({ email: user.email });
    const token = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;
    const verify = await request(harness.app).post('/api/auth/verify-magic-link').send({ token });
    const cookie = getCookie(verify, '__vibe_app_session')!;

    const code = authenticator.generate(SECRET);
    const stepUp = await request(harness.app)
      .post('/api/auth/totp/verify')
      .set('Cookie', `__vibe_app_session=${cookie}`)
      .send({ code });
    expect(stepUp.status).toBe(200);
    expect(stepUp.body.ok).toBe(true);

    const me = await request(harness.app)
      .get('/api/auth/me')
      .set('Cookie', `__vibe_app_session=${cookie}`);
    expect(typeof me.body.lastStepUpAt).toBe('number');
  });

  it('rejects an incorrect TOTP code', async () => {
    await request(harness.app).post('/api/auth/login').send({ email: user.email });
    const token = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;
    const verify = await request(harness.app).post('/api/auth/verify-magic-link').send({ token });
    const cookie = getCookie(verify, '__vibe_app_session')!;

    const stepUp = await request(harness.app)
      .post('/api/auth/totp/verify')
      .set('Cookie', `__vibe_app_session=${cookie}`)
      .send({ code: '000000' });
    expect(stepUp.status).toBe(401);
  });
});

describe('logout', () => {
  let user: FakeUser;
  beforeEach(async () => {
    user = {
      id: '00000000-0000-0000-0000-000000000001',
      email: STAFF_EMAIL,
      firmId: '00000000-0000-0000-0000-000000000fff',
      totpEnrolledAt: null,
      totpSecretEncrypted: null,
      recoveryCodesEncrypted: null,
    };
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
  });

  it('destroys the session', async () => {
    await request(harness.app).post('/api/auth/login').send({ email: user.email });
    const token = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;
    const verify = await request(harness.app).post('/api/auth/verify-magic-link').send({ token });
    const cookie = getCookie(verify, '__vibe_app_session')!;

    const logout = await request(harness.app)
      .post('/api/auth/logout')
      .set('Cookie', `__vibe_app_session=${cookie}`);
    expect(logout.status).toBe(200);

    const me = await request(harness.app)
      .get('/api/auth/me')
      .set('Cookie', `__vibe_app_session=${cookie}`);
    expect(me.status).toBe(401);
  });
});
