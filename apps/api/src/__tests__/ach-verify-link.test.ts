// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0218 — public ACH micro-deposit verification links. Covers the public
// verify surface (token → summary → verify), the staff pending-verification
// list, and the staff send-reminder endpoint that mints + emails the link.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  seedContact,
  type PgliteHarness,
} from './_pglite-harness';
import { achVerifyLinks, paymentMethod } from '@vibe/db/schema';
import type { Database } from '@vibe/db';

import { createAchVerifyPublicRouter } from '../pay-public/ach-verify';
import { createSavedMethodsRouter } from '../payments/saved-methods-routes';
import {
  createAchVerifyLink,
  hashAchVerifyToken,
  resolveAchVerifyLink,
} from '../payments/ach-verify-link';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
const OLD_STRIPE_KEY = process.env['STRIPE_SECRET_KEY'];

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  // resolveFirmStripe env fallback — verifyMicrodeposits needs creds.
  process.env['STRIPE_SECRET_KEY'] = 'sk_test_stub';
});

afterEach(async () => {
  await harness.close();
  if (OLD_STRIPE_KEY === undefined) delete process.env['STRIPE_SECRET_KEY'];
  else process.env['STRIPE_SECRET_KEY'] = OLD_STRIPE_KEY;
});

async function makePendingMethod(): Promise<string> {
  const [row] = await harness.db
    .insert(paymentMethod)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      kind: 'ACH',
      provider: 'STRIPE',
      providerToken: 'pm_test_bank',
      providerCustomerId: 'cus_test',
      lastFour: '6789',
      displayLabel: 'Test Bank ····6789',
      status: 'ACTIVE',
      verificationStatus: 'PENDING_MICRODEPOSIT',
      pendingSetupIntentId: 'seti_test_1',
    })
    .returning({ id: paymentMethod.id });
  return row!.id;
}

/** Stripe fetch stub for POST /setup_intents/:id/verify_microdeposits. */
function stripeFetch(outcome: 'succeeded' | 'wrong'): typeof fetch {
  return (async () => {
    if (outcome === 'wrong') {
      return new Response(
        JSON.stringify({ error: { code: 'incorrect_amounts', message: 'nope' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ id: 'seti_test_1', status: 'succeeded' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function publicApp(outcome: 'succeeded' | 'wrong' = 'succeeded') {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/ach-verify',
    createAchVerifyPublicRouter({ db: harness.db, fetchImpl: stripeFetch(outcome) }),
  );
  return app;
}

// =====================================================================
// Public verify surface
// =====================================================================
describe('0218 — public ACH verify surface', () => {
  it('unknown / malformed token → uniform 404', async () => {
    const app = publicApp();
    await request(app).get('/api/ach-verify/short').expect(404);
    await request(app).get('/api/ach-verify/this-token-does-not-exist-1').expect(404);
  });

  it('GET returns a safe summary + pending state and bumps the counter', async () => {
    const pmId = await makePendingMethod();
    const { token } = await createAchVerifyLink(harness.db, {
      firmId: seed.firmId,
      paymentMethodId: pmId,
    });
    const res = await request(publicApp()).get(`/api/ach-verify/${token}`).expect(200);
    expect(res.body.bankLabel).toBe('Test Bank ····6789');
    expect(res.body.state).toBe('pending');
    const [row] = await harness.db
      .select({ n: achVerifyLinks.accessCount })
      .from(achVerifyLinks)
      .where(eq(achVerifyLinks.tokenHash, hashAchVerifyToken(token)));
    expect(row!.n).toBe(1);
  });

  it('correct amounts verify the method and close the link', async () => {
    const pmId = await makePendingMethod();
    const { token } = await createAchVerifyLink(harness.db, {
      firmId: seed.firmId,
      paymentMethodId: pmId,
    });
    const res = await request(publicApp('succeeded'))
      .post(`/api/ach-verify/${token}/verify`)
      .send({ amounts: [32, 45] })
      .expect(200);
    expect(res.body.ok).toBe(true);

    const [pm] = await harness.db
      .select({ vs: paymentMethod.verificationStatus })
      .from(paymentMethod)
      .where(eq(paymentMethod.id, pmId));
    expect(pm!.vs).toBeNull();
    const link = await resolveAchVerifyLink(harness.db, token);
    expect(link!.status).toBe('VERIFIED');
    expect(link!.verifiedAt).not.toBeNull();
  });

  it('wrong amounts → 400 verification_failed, method stays pending', async () => {
    const pmId = await makePendingMethod();
    const { token } = await createAchVerifyLink(harness.db, {
      firmId: seed.firmId,
      paymentMethodId: pmId,
    });
    const res = await request(publicApp('wrong'))
      .post(`/api/ach-verify/${token}/verify`)
      .send({ amounts: [11, 22] })
      .expect(400);
    expect(res.body.error).toBe('verification_failed');
    const [pm] = await harness.db
      .select({ vs: paymentMethod.verificationStatus })
      .from(paymentMethod)
      .where(eq(paymentMethod.id, pmId));
    expect(pm!.vs).toBe('PENDING_MICRODEPOSIT');
  });

  it('expired link → friendly state on GET, 409 on POST', async () => {
    const pmId = await makePendingMethod();
    const { token } = await createAchVerifyLink(harness.db, {
      firmId: seed.firmId,
      paymentMethodId: pmId,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await request(publicApp()).get(`/api/ach-verify/${token}`).expect(200);
    expect(res.body.state).toBe('expired');
    await request(publicApp())
      .post(`/api/ach-verify/${token}/verify`)
      .send({ amounts: [32, 45] })
      .expect(409);
  });

  it('descriptor code works and a body with neither field is rejected', async () => {
    const pmId = await makePendingMethod();
    const { token } = await createAchVerifyLink(harness.db, {
      firmId: seed.firmId,
      paymentMethodId: pmId,
    });
    await request(publicApp()).post(`/api/ach-verify/${token}/verify`).send({}).expect(400);
    await request(publicApp('succeeded'))
      .post(`/api/ach-verify/${token}/verify`)
      .send({ descriptorCode: 'SM1234' })
      .expect(200);
  });
});

// =====================================================================
// Staff surface — pending list + send reminder
// =====================================================================

/** Invoke the LAST handler of a registered route with a stub req/res. */
async function invokeRoute(
  router: ReturnType<typeof createSavedMethodsRouter>,
  method: 'get' | 'post',
  path: string,
  req: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  const res: {
    statusCode: number;
    body: unknown;
    status: (n: number) => typeof res;
    json: (b: unknown) => typeof res;
    setHeader: () => void;
  } = {
    statusCode: 200,
    body: undefined,
    status(n: number) {
      this.statusCode = n;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader() {},
  };
  const stack = (
    router as unknown as {
      stack: {
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: { handle: (...a: unknown[]) => unknown }[];
        };
      }[];
    }
  ).stack;
  const layer = stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`route not registered: ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1]!.handle;
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
}

function staffReq(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
    ...over,
  };
}

describe('0218 — staff pending-verification + reminder', () => {
  it('lists pending methods with client name and lastReminderAt', async () => {
    const pmId = await makePendingMethod();
    const router = createSavedMethodsRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const res = await invokeRoute(router, 'get', '/pending-verification', staffReq());
    const items = (res.body as { items: { id: string; lastReminderAt: unknown }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(pmId);
    expect(items[0]!.lastReminderAt).toBeNull();
  });

  it('send-verification-reminder defaults to emailing the billing contact', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Billing Bob',
      email: 'bob@client.example',
      isBilling: true,
    });
    const pmId = await makePendingMethod();
    const sent: { to: string; subject: string; body: string }[] = [];
    const router = createSavedMethodsRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      sendStaffMail: async (a) => {
        sent.push(a);
      },
      portalBaseUrl: 'https://portal.firm.test',
    });
    const res = await invokeRoute(
      router,
      'post',
      '/:id/send-verification-reminder',
      staffReq({ params: { id: pmId } }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { sentToEmail: string; results: { email: string; sms: string } };
    expect(body.sentToEmail).toBe('bob@client.example');
    expect(body.results).toEqual({ email: 'sent', sms: 'skipped' });
    expect(sent).toHaveLength(1);
    const m = sent[0]!.body.match(/https:\/\/portal\.firm\.test\/verify-bank\/([A-Za-z0-9._-]+)/);
    expect(m).not.toBeNull();
    // The mailed token resolves to an ACTIVE link for this method.
    const link = await resolveAchVerifyLink(harness.db, m![1]!);
    expect(link).not.toBeNull();
    expect(link!.paymentMethodId).toBe(pmId);
    expect(link!.status).toBe('ACTIVE');
  });

  it('reminder to a chosen contact by SMS texts that contact', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Billing Bob',
      email: 'bob@client.example',
      isBilling: true,
    });
    const other = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Mobile Mia',
      mobile: '+15551234567',
    });
    const pmId = await makePendingMethod();
    const emails: unknown[] = [];
    const texts: { to: string; body: string }[] = [];
    const router = createSavedMethodsRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      sendStaffMail: async (a) => {
        emails.push(a);
      },
      sendSms: async (a) => {
        texts.push(a);
      },
      portalBaseUrl: 'https://portal.firm.test',
    });
    const res = await invokeRoute(
      router,
      'post',
      '/:id/send-verification-reminder',
      staffReq({
        params: { id: pmId },
        body: { contactId: other.contactId, channel: 'SMS' },
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { sentToPhone: string; results: { email: string; sms: string } };
    expect(body.sentToPhone).toBe('+15551234567');
    expect(body.results).toEqual({ email: 'skipped', sms: 'sent' });
    expect(emails).toHaveLength(0);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.body).toContain('https://portal.firm.test/verify-bank/');
  });

  it('email-only reminder without a billing email → 400 no_email_destination', async () => {
    const pmId = await makePendingMethod();
    const router = createSavedMethodsRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      sendStaffMail: async () => {},
      portalBaseUrl: 'https://portal.firm.test',
    });
    const res = await invokeRoute(
      router,
      'post',
      '/:id/send-verification-reminder',
      staffReq({ params: { id: pmId } }),
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('no_email_destination');
  });
});
