// SPDX-License-Identifier: Elastic-2.0
//
// Q6 — portal new-device re-verification. A magic-link sign-in from an
// unrecognized device is challenged with an SMS OTP before a session is
// issued; once verified, that device is trusted for subsequent logins.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import RedisMock from 'ioredis-mock';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { issueMagicLink, randomNonce } from '@vibe/core/auth';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createPortalAuthRouter } from '../auth/portal-routes';
import { createSessionStore } from '../auth/session-store';
import { resetConfigForTests } from '../config';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let redis: Redis;
let identityId: string;
let sentSms: Array<{ to: string; body: string }>;

const PORTAL_SECRET = 'test-portal-secret-' + 'x'.repeat(20);

function app(): express.Express {
  const a = express();
  a.use(express.json());
  const router = createPortalAuthRouter({
    db: harness.db,
    redis,
    sessionStore: createSessionStore(redis),
    sendEmail: async () => undefined,
    sendSms: async (m) => {
      sentSms.push(m);
    },
    requireAuth: (_req, _res, next) => next(),
  });
  a.use('/api/portal/auth', router);
  return a;
}

async function freshMagicToken(): Promise<string> {
  const nonce = randomNonce();
  const token = await issueMagicLink({
    subjectId: identityId,
    firmId: seed.firmId,
    realm: 'portal',
    signingKey: new TextEncoder().encode(PORTAL_SECRET),
    ttlSeconds: 600,
    nonce,
  });
  await redis.set(`magic-link:nonce:portal:${nonce}`, '1', 'EX', 600);
  return token;
}

beforeEach(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['STAFF_JWT_SECRET'] = 'test-staff-secret-' + 'x'.repeat(20);
  process.env['PORTAL_JWT_SECRET'] = PORTAL_SECRET;
  process.env['APP_BASE_URL'] = 'http://localhost:5173';
  process.env['PORTAL_BASE_URL'] = 'http://localhost:5174';
  resetConfigForTests();
  sentSms = [];
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const idRow = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email, primary_phone, primary_phone_verified_at)
        VALUES (${seed.firmId}, 'Client Tom', 'tom@client.example', '+15555550123', now())
        RETURNING id`,
  );
  identityId = (idRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status)
        VALUES (${identityId}, ${seed.clientId}, 'ACTIVE')`,
  );
});

afterEach(async () => {
  await harness.close();
});

describe('portal new-device verification (Q6)', () => {
  it('challenges an unrecognized device, then trusts it after the SMS code', async () => {
    const agent = request.agent(app());

    // First magic-link sign-in from this device → SMS challenge, no session.
    const t1 = await freshMagicToken();
    const r1 = await agent.post('/api/portal/auth/verify-magic-link').send({ token: t1 });
    expect(r1.status).toBe(200);
    expect(r1.body.deviceChallenge).toBe(true);
    expect(r1.body.challengeToken).toBeTruthy();
    expect(r1.body.phoneHint).toBe('0123');
    expect(r1.headers['set-cookie']).toBeUndefined();
    expect(sentSms).toHaveLength(1);
    const code = sentSms[0]!.body.match(/(\d{6})/)![1]!;

    // Wrong code is rejected.
    const bad = await agent
      .post('/api/portal/auth/verify-device-otp')
      .send({ challengeToken: r1.body.challengeToken, code: '000000' });
    expect(bad.status).toBe(401);

    // Correct code issues the session.
    const ok = await agent
      .post('/api/portal/auth/verify-device-otp')
      .send({ challengeToken: r1.body.challengeToken, code });
    expect(ok.status).toBe(200);
    expect(String(ok.headers['set-cookie'])).toContain('__vibe_portal_session');

    // Device is now trusted — a second magic-link sign-in from the same
    // agent (stable UA/IP) issues a session directly, no challenge.
    sentSms = [];
    const t2 = await freshMagicToken();
    const r2 = await agent.post('/api/portal/auth/verify-magic-link').send({ token: t2 });
    expect(r2.status).toBe(200);
    expect(r2.body.deviceChallenge).toBeUndefined();
    expect(r2.body.csrfToken).toBeTruthy();
    expect(sentSms).toHaveLength(0);
  });

  it('does not challenge when the identity has no verified phone', async () => {
    await harness.db.execute(
      sql`UPDATE portal_identity SET primary_phone = NULL, primary_phone_verified_at = NULL
          WHERE id = ${identityId}`,
    );
    const t1 = await freshMagicToken();
    const r1 = await request(app()).post('/api/portal/auth/verify-magic-link').send({ token: t1 });
    expect(r1.status).toBe(200);
    expect(r1.body.deviceChallenge).toBeUndefined();
    expect(r1.body.csrfToken).toBeTruthy();
    expect(sentSms).toHaveLength(0);
  });
});
