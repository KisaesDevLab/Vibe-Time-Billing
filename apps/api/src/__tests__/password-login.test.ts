// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0087 — username + password sign-in. Exercises the three-step flow:
//   POST /login/password → pending token + available factors
//   POST /2fa/start      → OTP sent (email/sms) or noop (TOTP)
//   POST /2fa/verify     → session cookie set, audit emitted
//
// Tests use ioredis-mock + a hand-stubbed DB (same harness as the
// magic-link tests). Each test rebuilds the harness so Redis is clean.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';

import { buildTestApp, type TestHarness } from './_test-app';
import { hashPassword } from '../auth/password';

const AT = '@';
const E = (local: string, domain: string): string => `${local}${AT}${domain}`;
const EMAIL = E('staff', 'firm.example');

interface FakeUserState {
  id: string;
  email: string;
  firmId: string;
  totpEnrolledAt: Date | null;
  totpSecretEncrypted: string | null;
  recoveryCodesEncrypted: string | null;
  passwordHash: string | null;
  smsOtpPhoneE164: string | null;
  smsOtpEnrolledAt: Date | null;
  emailOtpEnrolledAt: Date | null;
  preferredSecondFactor: 'TOTP' | 'EMAIL' | 'SMS' | null;
  // 0151 — the stub DB returns the same row for every select, so the
  // firm-settings policy read sees this field too. Absent = required.
  staffSecondFactorRequired?: boolean;
}

function fakeDb(initial: FakeUserState): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  current: () => FakeUserState;
} {
  const state = { ...initial };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ ...state, recovery: state.recoveryCodesEncrypted }],
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<FakeUserState>) => ({
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

const PASSWORD = 'correct-horse-battery-staple';
const WRONG_PASSWORD = 'wrong-password-but-also-long';
const FIRM_ID = '00000000-0000-0000-0000-00000000fff1';
const USER_ID = '00000000-0000-0000-0000-000000000a01';

let harness: TestHarness;

async function buildUser(over: Partial<FakeUserState> = {}): Promise<FakeUserState> {
  const passwordHash =
    over.passwordHash !== undefined ? over.passwordHash : await hashPassword(PASSWORD);
  return {
    id: USER_ID,
    email: EMAIL,
    firmId: FIRM_ID,
    totpEnrolledAt: null,
    totpSecretEncrypted: null,
    recoveryCodesEncrypted: null,
    passwordHash,
    smsOtpPhoneE164: null,
    smsOtpEnrolledAt: null,
    emailOtpEnrolledAt: null,
    preferredSecondFactor: null,
    ...over,
  };
}

describe('POST /api/auth/login/password', () => {
  it('returns 401 invalid_credentials when the password is wrong', async () => {
    const user = await buildUser();
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const res = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: WRONG_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('returns 400 no_factor_enrolled when the user has no second factor', async () => {
    const user = await buildUser();
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const res = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_factor_enrolled');
  });

  it('returns a pendingToken + availableFactors when password + factor are set', async () => {
    const user = await buildUser({
      emailOtpEnrolledAt: new Date(),
      preferredSecondFactor: 'EMAIL',
    });
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const res = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.pendingToken).toBeTypeOf('string');
    expect(res.body.availableFactors).toEqual(['EMAIL']);
    expect(res.body.preferredFactor).toBe('EMAIL');
  });

  it('0151 — issues a session directly when the firm disabled the second factor', async () => {
    // No factor enrolled at all — with the requirement off, the password
    // alone completes sign-in instead of 400 no_factor_enrolled.
    const user = await buildUser({ staffSecondFactorRequired: false });
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const res = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.csrfToken).toBeTypeOf('string');
    expect(res.body.pendingToken).toBeUndefined();
    expect(getCookie(res, '__vibe_app_session')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('0151 — still 401s on a wrong password when the second factor is off', async () => {
    const user = await buildUser({ staffSecondFactorRequired: false });
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const res = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: WRONG_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('does NOT leak whether the email exists', async () => {
    // No user in DB at all → also 401 invalid_credentials (same as wrong password).
    const { db } = fakeDb({
      id: 'nobody',
      email: 'someone-else@x.example',
      firmId: FIRM_ID,
      totpEnrolledAt: null,
      totpSecretEncrypted: null,
      recoveryCodesEncrypted: null,
      passwordHash: null,
      smsOtpPhoneE164: null,
      smsOtpEnrolledAt: null,
      emailOtpEnrolledAt: null,
      preferredSecondFactor: null,
    });
    harness = await buildTestApp({ db });
    const res = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });
});

describe('POST /api/auth/2fa/start', () => {
  it('sends an email OTP and returns a masked recipient', async () => {
    const user = await buildUser({ emailOtpEnrolledAt: new Date() });
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const login = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: PASSWORD });
    const pendingToken = login.body.pendingToken as string;

    const start = await request(harness.app)
      .post('/api/auth/2fa/start')
      .send({ pendingToken, factor: 'EMAIL' });
    expect(start.status).toBe(200);
    expect(start.body.ok).toBe(true);
    expect(start.body.factor).toBe('EMAIL');
    expect(start.body.sentTo).toMatch(/@firm\.example/);
    expect(harness.capturedEmailOtps).toHaveLength(1);
    expect(harness.capturedEmailOtps[0]!.code).toMatch(/^\d{6}$/);
  });

  it('rejects when the requested factor is not enrolled', async () => {
    const user = await buildUser({ emailOtpEnrolledAt: new Date() });
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const login = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: PASSWORD });
    const pendingToken = login.body.pendingToken as string;

    const start = await request(harness.app)
      .post('/api/auth/2fa/start')
      .send({ pendingToken, factor: 'SMS' });
    expect(start.status).toBe(400);
    expect(start.body.error).toBe('factor_not_enrolled');
  });

  it('TOTP factor is a noop (no OTP sent — code comes from the app)', async () => {
    const secret = authenticator.generateSecret();
    const user = await buildUser({
      totpEnrolledAt: new Date(),
      totpSecretEncrypted: secret,
    });
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const login = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: PASSWORD });
    const pendingToken = login.body.pendingToken as string;

    const start = await request(harness.app)
      .post('/api/auth/2fa/start')
      .send({ pendingToken, factor: 'TOTP' });
    expect(start.status).toBe(200);
    expect(start.body.factor).toBe('TOTP');
    expect(harness.capturedEmailOtps).toHaveLength(0);
    expect(harness.capturedSmsOtps).toHaveLength(0);
  });
});

describe('POST /api/auth/2fa/verify', () => {
  it('creates a session + cookie + LOGIN audit on correct email OTP', async () => {
    const user = await buildUser({ emailOtpEnrolledAt: new Date() });
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const login = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: PASSWORD });
    const pendingToken = login.body.pendingToken as string;
    await request(harness.app).post('/api/auth/2fa/start').send({ pendingToken, factor: 'EMAIL' });
    const code = harness.capturedEmailOtps[0]!.code;

    const verify = await request(harness.app)
      .post('/api/auth/2fa/verify')
      .send({ pendingToken, factor: 'EMAIL', code });
    expect(verify.status).toBe(200);
    expect(verify.body.ok).toBe(true);
    expect(verify.body.csrfToken).toMatch(/^[0-9a-f]{48}$/);
    expect(getCookie(verify, '__vibe_app_session')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a wrong code', async () => {
    const user = await buildUser({ emailOtpEnrolledAt: new Date() });
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const login = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: PASSWORD });
    const pendingToken = login.body.pendingToken as string;
    await request(harness.app).post('/api/auth/2fa/start').send({ pendingToken, factor: 'EMAIL' });

    const verify = await request(harness.app)
      .post('/api/auth/2fa/verify')
      .send({ pendingToken, factor: 'EMAIL', code: '000000' });
    expect(verify.status).toBe(401);
    expect(verify.body.error).toBe('invalid_code');
  });

  it('accepts a TOTP code from the authenticator app', async () => {
    const secret = authenticator.generateSecret();
    const user = await buildUser({
      totpEnrolledAt: new Date(),
      totpSecretEncrypted: secret,
    });
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const login = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: PASSWORD });
    const pendingToken = login.body.pendingToken as string;
    await request(harness.app).post('/api/auth/2fa/start').send({ pendingToken, factor: 'TOTP' });

    const code = authenticator.generate(secret);
    const verify = await request(harness.app)
      .post('/api/auth/2fa/verify')
      .send({ pendingToken, factor: 'TOTP', code });
    expect(verify.status).toBe(200);
    expect(getCookie(verify, '__vibe_app_session')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an invalid pendingToken', async () => {
    const user = await buildUser({ emailOtpEnrolledAt: new Date() });
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const verify = await request(harness.app)
      .post('/api/auth/2fa/verify')
      .send({ pendingToken: 'garbage.token.here', factor: 'EMAIL', code: '123456' });
    expect(verify.status).toBe(401);
    expect(verify.body.error).toBe('invalid_pending_token');
  });

  it('OTP code is single-use — second verify with the same code fails', async () => {
    const user = await buildUser({ emailOtpEnrolledAt: new Date() });
    const { db } = fakeDb(user);
    harness = await buildTestApp({ db });
    const login = await request(harness.app)
      .post('/api/auth/login/password')
      .send({ email: EMAIL, password: PASSWORD });
    const pendingToken = login.body.pendingToken as string;
    await request(harness.app).post('/api/auth/2fa/start').send({ pendingToken, factor: 'EMAIL' });
    const code = harness.capturedEmailOtps[0]!.code;
    const first = await request(harness.app)
      .post('/api/auth/2fa/verify')
      .send({ pendingToken, factor: 'EMAIL', code });
    expect(first.status).toBe(200);

    const second = await request(harness.app)
      .post('/api/auth/2fa/verify')
      .send({ pendingToken, factor: 'EMAIL', code });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('otp_expired_or_missing');
  });
});
