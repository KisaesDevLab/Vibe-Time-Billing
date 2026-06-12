// SPDX-License-Identifier: Elastic-2.0
//
// Phase 3 item 6 + Phase 12 item 29: the adjustment-create endpoint
// requires fresh step-up TOTP. A session without lastStepUpAt set
// must be rejected with 403 step_up_required.

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import { buildTestApp, type TestHarness } from './_test-app';

const AT = '@';
const EMAIL = `boss${AT}example.com`;

function fakeDb(rowExtra: Record<string, unknown> = {}) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: '00000000-0000-0000-0000-000000000001',
              email: EMAIL,
              firmId: '00000000-0000-0000-0000-000000000fff',
              totpEnrolledAt: null,
              totpSecretEncrypted: null,
              recovery: null,
              // The stub returns this same row for every select, so the
              // 0151 firm-settings policy read sees rowExtra too.
              ...rowExtra,
            },
          ],
        }),
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'x' }] }) }),
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

describe('adjustments require step-up', () => {
  let harness: TestHarness;
  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    harness = await buildTestApp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeDb() as any,
      fakeUserRoles: new Map([['00000000-0000-0000-0000-000000000001', ['partner']]]),
    });
  });

  it('rejects with 403 step_up_required when session is freshly created', async () => {
    await request(harness.app).post('/api/auth/login').send({ email: EMAIL });
    const token = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;
    const verify = await request(harness.app).post('/api/auth/verify-magic-link').send({ token });
    const cookie = cookieValue(verify, '__vibe_app_session')!;
    const csrf = verify.body.csrfToken;

    const res = await request(harness.app)
      .post('/api/staff/adjustments')
      .set('Cookie', `__vibe_app_session=${cookie}`)
      .set('X-CSRF-Token', csrf)
      .send({
        billingBatchId: '00000000-0000-0000-0000-000000000aaa',
        method: 'TIME',
        allocationMethod: 'PRO_RATA_BY_VALUE',
        totalAmountCents: -50000,
        reasonCodeId: '00000000-0000-0000-0000-000000000bbb',
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('step_up_required');
  });

  it('0151 — passes the step-up gate when the firm disabled the second factor', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    harness = await buildTestApp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeDb({ staffSecondFactorRequired: false }) as any,
      fakeUserRoles: new Map([['00000000-0000-0000-0000-000000000001', ['partner']]]),
    });
    await request(harness.app).post('/api/auth/login').send({ email: EMAIL });
    const token = new URL(harness.capturedMagicLinks[0]!.link).searchParams.get('token')!;
    const verify = await request(harness.app).post('/api/auth/verify-magic-link').send({ token });
    const cookie = cookieValue(verify, '__vibe_app_session')!;
    const csrf = verify.body.csrfToken;

    const res = await request(harness.app)
      .post('/api/staff/adjustments')
      .set('Cookie', `__vibe_app_session=${cookie}`)
      .set('X-CSRF-Token', csrf)
      .send({
        billingBatchId: '00000000-0000-0000-0000-000000000aaa',
        method: 'TIME',
        allocationMethod: 'PRO_RATA_BY_VALUE',
        totalAmountCents: -50000,
        reasonCodeId: '00000000-0000-0000-0000-000000000bbb',
      });
    // The request clears the step-up guard (the stub DB can't satisfy the
    // rest of the handler) — the point is it's no longer step_up_required.
    expect(res.body.error).not.toBe('step_up_required');
  });
});
