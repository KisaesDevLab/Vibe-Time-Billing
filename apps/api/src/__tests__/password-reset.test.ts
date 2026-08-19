// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// "Forgot password" → emailed single-use reset link → new password.
//   POST /api/auth/password/forgot { email }            → always 200 (Q29)
//   POST /api/auth/password/reset  { token, newPassword } → 200 ok
// A reset token must never work as a magic link (distinct audience), must
// be single-use, and resetting must revoke existing staff sessions.
// Same harness as password-login.test.ts: ioredis-mock + stubbed DB.

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { buildTestApp, type TestHarness } from './_test-app';
import { hashPassword, verifyPassword } from '../auth/password';

const AT = '@';
const E = (local: string, domain: string): string => `${local}${AT}${domain}`;
const EMAIL = E('staff', 'firm.example');
const FIRM_ID = '00000000-0000-0000-0000-00000000fff1';
const USER_ID = '00000000-0000-0000-0000-000000000a01';
const OLD_PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-brand-new-long-password';

interface FakeUserState {
  id: string;
  email: string;
  firmId: string;
  passwordHash: string | null;
  passwordSetAt: Date | null;
  totpEnrolledAt: Date | null;
  totpSecretEncrypted: string | null;
  recoveryCodesEncrypted: string | null;
  smsOtpPhoneE164: string | null;
  smsOtpEnrolledAt: Date | null;
  emailOtpEnrolledAt: Date | null;
  preferredSecondFactor: 'TOTP' | 'EMAIL' | 'SMS' | null;
  staffSecondFactorRequired?: boolean;
}

function fakeDb(initial: FakeUserState | null): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  current: () => FakeUserState | null;
} {
  const state = initial ? { ...initial } : null;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (state ? [{ ...state }] : []),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<FakeUserState>) => ({
        where: async () => (state ? Object.assign(state, patch) : undefined),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
  };
  return { db, current: () => state };
}

async function buildUser(over: Partial<FakeUserState> = {}): Promise<FakeUserState> {
  return {
    id: USER_ID,
    email: EMAIL,
    firmId: FIRM_ID,
    passwordHash: await hashPassword(OLD_PASSWORD),
    passwordSetAt: new Date('2026-01-01T00:00:00Z'),
    totpEnrolledAt: null,
    totpSecretEncrypted: null,
    recoveryCodesEncrypted: null,
    smsOtpPhoneE164: null,
    smsOtpEnrolledAt: null,
    emailOtpEnrolledAt: null,
    preferredSecondFactor: null,
    staffSecondFactorRequired: false,
    ...over,
  };
}

function tokenFromLink(link: string): string {
  const url = new URL(link);
  expect(url.pathname).toBe('/auth/reset-password');
  return url.searchParams.get('token')!;
}

let harness: TestHarness;

describe('POST /api/auth/password/forgot', () => {
  it('emails a reset link pointing at /auth/reset-password for a known user', async () => {
    const { db } = fakeDb(await buildUser());
    harness = await buildTestApp({ db });
    const res = await request(harness.app).post('/api/auth/password/forgot').send({ email: EMAIL });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      message: expect.stringContaining('password reset link'),
    });
    expect(harness.capturedPasswordResets).toHaveLength(1);
    expect(harness.capturedPasswordResets[0]!.email).toBe(EMAIL);
    expect(harness.capturedPasswordResets[0]!.firmId).toBe(FIRM_ID);
    const token = tokenFromLink(harness.capturedPasswordResets[0]!.link);
    expect(token.split('.')).toHaveLength(3); // signed JWT
    // Nothing went out on the magic-link channel.
    expect(harness.capturedMagicLinks).toHaveLength(0);
  });

  it('returns the identical 200 body for an unknown email and sends nothing', async () => {
    const { db } = fakeDb(null);
    harness = await buildTestApp({ db });
    const res = await request(harness.app)
      .post('/api/auth/password/forgot')
      .send({ email: E('nobody', 'firm.example') });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      message: expect.stringContaining('password reset link'),
    });
    expect(harness.capturedPasswordResets).toHaveLength(0);
  });

  it('rate-limits per contact (5 / 15 min) with the same 200 body', async () => {
    const { db } = fakeDb(await buildUser());
    harness = await buildTestApp({ db });
    for (let i = 0; i < 6; i++) {
      const res = await request(harness.app)
        .post('/api/auth/password/forgot')
        .send({ email: EMAIL });
      expect(res.status).toBe(200);
    }
    expect(harness.capturedPasswordResets).toHaveLength(5);
  });

  it('rejects a malformed payload', async () => {
    const { db } = fakeDb(await buildUser());
    harness = await buildTestApp({ db });
    const res = await request(harness.app)
      .post('/api/auth/password/forgot')
      .send({ email: 'nope' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/password/reset', () => {
  async function requestToken(): Promise<string> {
    await request(harness.app).post('/api/auth/password/forgot').send({ email: EMAIL });
    return tokenFromLink(harness.capturedPasswordResets.at(-1)!.link);
  }

  it('sets the new argon2id hash, bumps password_set_at, and is single-use', async () => {
    const { db, current } = fakeDb(await buildUser());
    harness = await buildTestApp({ db });
    const token = await requestToken();
    const res = await request(harness.app)
      .post('/api/auth/password/reset')
      .send({ token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const row = current()!;
    expect(await verifyPassword(NEW_PASSWORD, row.passwordHash!)).toBe(true);
    expect(await verifyPassword(OLD_PASSWORD, row.passwordHash!)).toBe(false);
    expect(row.passwordSetAt!.getTime()).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
    // No session is minted by a reset.
    expect(res.headers['set-cookie']).toBeUndefined();

    // Replaying the same link is refused.
    const again = await request(harness.app)
      .post('/api/auth/password/reset')
      .send({ token, newPassword: 'yet-another-long-password' });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('token_already_used');
  });

  it('the new password signs in; the old one does not', async () => {
    const { db } = fakeDb(await buildUser());
    harness = await buildTestApp({ db });
    const token = await requestToken();
    await request(harness.app)
      .post('/api/auth/password/reset')
      .send({ token, newPassword: NEW_PASSWORD });
    const old = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: OLD_PASSWORD });
    expect(old.status).toBe(401);
    const fresh = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: NEW_PASSWORD });
    expect(fresh.status).toBe(200);
  });

  it('revokes existing staff sessions when the password changes', async () => {
    const { db } = fakeDb(await buildUser());
    harness = await buildTestApp({ db });
    // Sign in first (firm has 2FA off → password alone yields a session).
    const login = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: OLD_PASSWORD });
    expect(login.status).toBe(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const me1 = await request(harness.app).get('/api/auth/me').set('Cookie', cookie);
    expect(me1.status).toBe(200);

    const token = await requestToken();
    await request(harness.app)
      .post('/api/auth/password/reset')
      .send({ token, newPassword: NEW_PASSWORD });
    const me2 = await request(harness.app).get('/api/auth/me').set('Cookie', cookie);
    expect(me2.status).toBe(401);
  });

  it('enforces the password policy without burning the token', async () => {
    const { db, current } = fakeDb(await buildUser());
    harness = await buildTestApp({ db });
    const token = await requestToken();
    const short = await request(harness.app)
      .post('/api/auth/password/reset')
      .send({ token, newPassword: 'short' });
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ error: 'password_policy', reason: 'too_short' });
    expect(await verifyPassword(OLD_PASSWORD, current()!.passwordHash!)).toBe(true);
    // Same link still works once a compliant password is supplied.
    const ok = await request(harness.app)
      .post('/api/auth/password/reset')
      .send({ token, newPassword: NEW_PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('rejects garbage, expired-style, and cross-purpose tokens', async () => {
    const { db } = fakeDb(await buildUser());
    harness = await buildTestApp({ db });
    const bad = await request(harness.app)
      .post('/api/auth/password/reset')
      .send({ token: 'not.a.jwt', newPassword: NEW_PASSWORD });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('invalid_token');

    // A genuine MAGIC-LINK token is not accepted as a reset token …
    await request(harness.app).post('/api/auth/login').send({ email: EMAIL });
    const magic = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;
    const cross = await request(harness.app)
      .post('/api/auth/password/reset')
      .send({ token: magic, newPassword: NEW_PASSWORD });
    expect(cross.status).toBe(401);
    expect(cross.body.error).toBe('invalid_token');

    // … and a reset token is not accepted as a magic link.
    const reset = await requestToken();
    const asMagic = await request(harness.app)
      .post('/api/auth/verify-magic-link')
      .send({ token: reset });
    expect(asMagic.status).toBe(401);
    expect(asMagic.body.error).toBe('invalid_token');
  });
});
