// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0181 — pay-by-link (no portal login). Covers the public pay surface,
// the staff send (email/SMS) + revoke endpoints, and the Stripe
// checkout.session.completed webhook that settles the payment into the
// existing ledger and flips the link to PAID.

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
import {
  creditMemos,
  invoicePayLinks,
  invoiceReminderLog,
  invoices,
  notificationTemplates,
  payments,
} from '@vibe/db/schema';
import type { Database } from '@vibe/db';
import type { PaymentProvider } from '@vibe/core/payments';

import { createInvoicePayPublicRouter } from '../pay-public/invoice-pay';
import { createInvoiceRouter } from '../invoices/routes';
import { createStripeWebhookRouter } from '../webhooks/stripe';
import { createPayLink, hashPayLinkToken } from '../payments/pay-link-helper';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});

afterEach(async () => {
  await harness.close();
});

async function makeInvoice(
  over: { totalCents?: number; paidCents?: number; status?: string } = {},
): Promise<string> {
  const [inv] = await harness.db
    .insert(invoices)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      invoiceNumber: 'INV-1042',
      issueDate: '2026-06-01',
      dueDate: '2026-06-15',
      subtotalCents: over.totalCents ?? 10000,
      totalCents: over.totalCents ?? 10000,
      paidCents: over.paidCents ?? 0,
      status: (over.status ?? 'SENT') as 'SENT',
    })
    .returning({ id: invoices.id });
  return inv!.id;
}

// Fake provider capturing the checkout-session args.
function stubStripe(opts: { ok?: boolean; capture?: (a: unknown) => void } = {}): PaymentProvider {
  return {
    id: 'stripe',
    verifyWebhookSignature() {
      return true;
    },
    charge() {
      throw new Error('unused');
    },
    refund() {
      throw new Error('unused');
    },
    async createCheckoutSession(req: unknown) {
      opts.capture?.(req);
      if (opts.ok === false) return { ok: false, errorMessage: 'boom' };
      return {
        ok: true,
        sessionId: 'cs_test_123',
        url: 'https://checkout.stripe.test/cs_test_123',
      };
    },
  } as unknown as PaymentProvider;
}

function publicApp(stripe: PaymentProvider | null) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/pay',
    createInvoicePayPublicRouter({
      db: harness.db,
      stripe,
      publicBaseUrl: 'https://pay.firm.test',
    }),
  );
  return app;
}

// =====================================================================
// Public pay surface
// =====================================================================
describe('0181 — public pay surface', () => {
  it('unknown / malformed token → uniform 404', async () => {
    const app = publicApp(stubStripe());
    await request(app).get('/api/pay/short').expect(404); // fails TOKEN_RE
    await request(app).get('/api/pay/this-token-does-not-exist-abc').expect(404);
  });

  it('GET returns a safe summary + payable state', async () => {
    const invoiceId = await makeInvoice({ totalCents: 25000 });
    const { token } = await createPayLink(harness.db, { firmId: seed.firmId, invoiceId });
    const app = publicApp(stubStripe());
    const res = await request(app).get(`/api/pay/${token}`).expect(200);
    expect(res.body.balanceCents).toBe(25000);
    expect(res.body.invoiceNumber).toBe('INV-1042');
    expect(res.body.state).toBe('payable');
    // access counter bumped
    const [row] = await harness.db
      .select({ n: invoicePayLinks.accessCount })
      .from(invoicePayLinks)
      .where(eq(invoicePayLinks.tokenHash, hashPayLinkToken(token)));
    expect(row!.n).toBe(1);
  });

  it('checkout opens a session, stores its id, and stamps resolving metadata', async () => {
    const invoiceId = await makeInvoice({ totalCents: 30000, paidCents: 5000 });
    const { token, id: linkId } = await createPayLink(harness.db, {
      firmId: seed.firmId,
      invoiceId,
    });
    let captured: Record<string, unknown> | undefined;
    const app = publicApp(
      stubStripe({ capture: (a) => (captured = a as Record<string, unknown>) }),
    );
    const res = await request(app).post(`/api/pay/${token}/checkout`).expect(200);
    expect(res.body.url).toContain('checkout.stripe.test');
    // charges the open balance, not the total
    expect(captured!['amountCents']).toBe(25000);
    const meta = captured!['metadata'] as Record<string, string>;
    expect(meta['invoice_id']).toBe(invoiceId);
    expect(meta['pay_link_token_hash']).toBe(hashPayLinkToken(token));
    // session id persisted for reconciliation
    const [row] = await harness.db
      .select({ s: invoicePayLinks.stripeSessionId })
      .from(invoicePayLinks)
      .where(eq(invoicePayLinks.id, linkId));
    expect(row!.s).toBe('cs_test_123');
  });

  it('checkout on a voided link → 409', async () => {
    const invoiceId = await makeInvoice();
    const { token, id } = await createPayLink(harness.db, { firmId: seed.firmId, invoiceId });
    await harness.db
      .update(invoicePayLinks)
      .set({ status: 'VOIDED' })
      .where(eq(invoicePayLinks.id, id));
    const app = publicApp(stubStripe());
    const res = await request(app).post(`/api/pay/${token}/checkout`).expect(409);
    expect(res.body.reason).toBe('voided');
  });

  it('checkout with no provider configured → 503', async () => {
    const invoiceId = await makeInvoice();
    const { token } = await createPayLink(harness.db, { firmId: seed.firmId, invoiceId });
    const app = publicApp(null);
    await request(app).post(`/api/pay/${token}/checkout`).expect(503);
  });
});

// =====================================================================
// Stripe webhook — checkout.session.completed
// =====================================================================
describe('0181 — checkout.session.completed webhook', () => {
  function webhookApp() {
    const app = express();
    app.use(
      '/api/webhooks/stripe',
      createStripeWebhookRouter({ db: harness.db, stripe: stubStripe(), webhookSecret: 'whsec' }),
    );
    return app;
  }

  function event(over: { tokenHash: string; invoiceId: string; pi?: string; amount?: number }) {
    return {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          payment_intent: over.pi ?? 'pi_test_1',
          amount_total: over.amount ?? 10000,
          metadata: {
            pay_link_token_hash: over.tokenHash,
            invoice_id: over.invoiceId,
          },
        },
      },
    };
  }

  function send(app: express.Express, body: unknown) {
    return request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=0,v1=stub')
      .send(JSON.stringify(body));
  }

  it('records payment, marks invoice PAID + link PAID', async () => {
    const invoiceId = await makeInvoice({ totalCents: 10000 });
    const { token, id: linkId } = await createPayLink(harness.db, {
      firmId: seed.firmId,
      invoiceId,
    });
    const app = webhookApp();
    await send(app, event({ tokenHash: hashPayLinkToken(token), invoiceId })).expect(200);

    const [pay] = await harness.db.select().from(payments).where(eq(payments.invoiceId, invoiceId));
    expect(pay!.status).toBe('SUCCEEDED');
    expect(pay!.amountCents).toBe(10000);
    const [inv] = await harness.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv!.status).toBe('PAID');
    expect(inv!.paidCents).toBe(10000);
    const [link] = await harness.db
      .select()
      .from(invoicePayLinks)
      .where(eq(invoicePayLinks.id, linkId));
    expect(link!.status).toBe('PAID');
    expect(link!.paidAt).not.toBeNull();
  });

  it('re-delivery is idempotent (no double payment)', async () => {
    const invoiceId = await makeInvoice({ totalCents: 10000 });
    const { token } = await createPayLink(harness.db, { firmId: seed.firmId, invoiceId });
    const app = webhookApp();
    const ev = event({ tokenHash: hashPayLinkToken(token), invoiceId });
    await send(app, ev).expect(200);
    await send(app, ev).expect(200);
    const rows = await harness.db.select().from(payments).where(eq(payments.invoiceId, invoiceId));
    expect(rows.length).toBe(1);
  });

  it('partial payment leaves invoice PARTIALLY_PAID', async () => {
    const invoiceId = await makeInvoice({ totalCents: 10000 });
    const { token } = await createPayLink(harness.db, { firmId: seed.firmId, invoiceId });
    const app = webhookApp();
    await send(app, event({ tokenHash: hashPayLinkToken(token), invoiceId, amount: 4000 })).expect(
      200,
    );
    const [inv] = await harness.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv!.status).toBe('PARTIALLY_PAID');
    expect(inv!.paidCents).toBe(4000);
  });

  it('settles two distinct payments on one invoice to the exact sum (absolute recompute)', async () => {
    const invoiceId = await makeInvoice({ totalCents: 10000 });
    const a = await createPayLink(harness.db, { firmId: seed.firmId, invoiceId });
    const b = await createPayLink(harness.db, { firmId: seed.firmId, invoiceId });
    const app = webhookApp();
    await send(
      app,
      event({ tokenHash: hashPayLinkToken(a.token), invoiceId, pi: 'pi_a', amount: 6000 }),
    ).expect(200);
    await send(
      app,
      event({ tokenHash: hashPayLinkToken(b.token), invoiceId, pi: 'pi_b', amount: 4000 }),
    ).expect(200);
    const [inv] = await harness.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv!.paidCents).toBe(10000); // exact sum, no lost update
    expect(inv!.status).toBe('PAID');
    const rows = await harness.db.select().from(payments).where(eq(payments.invoiceId, invoiceId));
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status === 'SUCCEEDED')).toBe(true);
  });

  it('clamps an overpayment to the current open balance', async () => {
    // $80 already paid (a real prior payment), then a pay-link charges the
    // full $100 (race) — only $20 should apply, $80 becomes credit.
    const invoiceId = await makeInvoice({ totalCents: 10000, paidCents: 8000 });
    await harness.db.insert(payments).values({
      invoiceId,
      amountCents: 8000,
      feeCents: 0,
      provider: 'STRIPE',
      providerChargeId: 'pi_prior',
      status: 'SUCCEEDED',
      receivedAt: new Date(),
    });
    const { token } = await createPayLink(harness.db, { firmId: seed.firmId, invoiceId });
    const app = webhookApp();
    await send(app, event({ tokenHash: hashPayLinkToken(token), invoiceId, amount: 10000 })).expect(
      200,
    );
    const [pay] = await harness.db
      .select()
      .from(payments)
      .where(eq(payments.providerChargeId, 'pi_test_1'));
    expect(pay!.amountCents).toBe(2000); // clamped to open balance, not the $100 charged
    const [inv] = await harness.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv!.status).toBe('PAID');
    expect(inv!.paidCents).toBe(10000); // exactly total, never over
    // The $80 surplus Stripe captured is banked as an OPEN client credit.
    const credits = await harness.db.select().from(creditMemos);
    expect(credits).toHaveLength(1);
    expect(credits[0]!.source).toBe('OVERPAYMENT');
    expect(Number(credits[0]!.originalAmountCents)).toBe(8000);
  });

  it('an entirely-redundant pay-link charge is banked as credit, not dropped', async () => {
    // Invoice already fully paid; a second pay-link still completes a charge.
    const invoiceId = await makeInvoice({ totalCents: 10000, paidCents: 10000, status: 'PAID' });
    const { token } = await createPayLink(harness.db, { firmId: seed.firmId, invoiceId });
    const app = webhookApp();
    await send(app, event({ tokenHash: hashPayLinkToken(token), invoiceId, amount: 10000 })).expect(
      200,
    );
    // No payment row applied to the invoice; the full $100 is an open credit.
    expect(await harness.db.select().from(payments)).toHaveLength(0);
    const credits = await harness.db.select().from(creditMemos);
    expect(credits).toHaveLength(1);
    expect(Number(credits[0]!.originalAmountCents)).toBe(10000);
    // Invoice untouched; link marked PAID.
    const [inv] = await harness.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv!.paidCents).toBe(10000);
    const [link] = await harness.db
      .select()
      .from(invoicePayLinks)
      .where(eq(invoicePayLinks.tokenHash, hashPayLinkToken(token)));
    expect(link!.status).toBe('PAID');
  });

  it('event without pay-link metadata is ignored', async () => {
    const app = webhookApp();
    await send(app, {
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', payment_intent: 'pi_x', amount_total: 5000, metadata: {} } },
    }).expect(200);
    const rows = await harness.db.select().from(payments);
    expect(rows.length).toBe(0);
  });
});

// =====================================================================
// Staff send / revoke — invoke the route handler directly (bypassing the
// auth middleware, which is the established invoice-router test pattern).
// =====================================================================
interface FakeRes {
  statusCode: number;
  jsonBody: {
    ok?: boolean;
    payUrl?: string;
    results?: { email: string; sms: string };
    error?: string;
  };
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: {},
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b as FakeRes['jsonBody'];
      return this;
    },
  };
}
async function invokeLast(
  router: express.Router,
  method: 'get' | 'post',
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
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

function staffReq(invoiceId: string, body: unknown): Record<string, unknown> {
  return {
    body,
    params: { id: invoiceId },
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

describe('0181 — staff pay-link send/revoke', () => {
  function buildRouter(over: {
    sendEmail?: (a: { to: string; subject: string; body: string }) => Promise<void>;
    sendSms?: (a: { to: string; body: string }) => Promise<void>;
  }) {
    return createInvoiceRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      publicBaseUrl: 'https://pay.firm.test',
      ...over,
    });
  }

  it('emails a payment request, logs the send, returns a pay URL', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Payer',
      email: 'pat@payer.test',
      isBilling: true,
    });
    const invoiceId = await makeInvoice();
    const sent: { to: string }[] = [];
    const router = buildRouter({
      sendEmail: async (a) => {
        sent.push({ to: a.to });
      },
    });
    const res = await invokeLast(
      router,
      'post',
      '/:id/pay-link/send',
      staffReq(invoiceId, { channel: 'EMAIL' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.results!.email).toBe('sent');
    expect(res.jsonBody.payUrl).toContain('https://pay.firm.test/pay/');
    expect(sent[0]!.to).toBe('pat@payer.test');
    const logs = await harness.db
      .select()
      .from(invoiceReminderLog)
      .where(eq(invoiceReminderLog.invoiceId, invoiceId));
    expect(logs.length).toBe(1);
    expect(logs[0]!.channel).toBe('EMAIL');
    // a live ACTIVE link now exists
    const links = await harness.db
      .select()
      .from(invoicePayLinks)
      .where(eq(invoicePayLinks.invoiceId, invoiceId));
    expect(links.filter((l) => l.status === 'ACTIVE').length).toBe(1);
  });

  it('SMS requested but no phone on file → 409', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'No Phone',
      email: 'np@payer.test',
      isBilling: true,
    });
    const invoiceId = await makeInvoice();
    const router = buildRouter({ sendSms: async () => undefined });
    const res = await invokeLast(
      router,
      'post',
      '/:id/pay-link/send',
      staffReq(invoiceId, { channel: 'SMS' }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.jsonBody.error).toBe('no_sms_destination');
  });

  it('BOTH dispatches email and SMS independently', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Both Channels',
      email: 'both@payer.test',
      phone: '+15555550123',
      isBilling: true,
    });
    const invoiceId = await makeInvoice();
    const emails: string[] = [];
    const texts: string[] = [];
    const router = buildRouter({
      sendEmail: async (a) => {
        emails.push(a.to);
      },
      sendSms: async (a) => {
        texts.push(a.to);
      },
    });
    const res = await invokeLast(
      router,
      'post',
      '/:id/pay-link/send',
      staffReq(invoiceId, { channel: 'BOTH' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.results).toEqual({ email: 'sent', sms: 'sent' });
    expect(emails).toEqual(['both@payer.test']);
    expect(texts).toEqual(['+15555550123']);
    const logs = await harness.db
      .select()
      .from(invoiceReminderLog)
      .where(eq(invoiceReminderLog.invoiceId, invoiceId));
    expect(logs.map((l) => l.channel).sort()).toEqual(['EMAIL', 'SMS']);
  });

  it('re-sending mints an independent link without invalidating the prior one', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Payer',
      email: 'pat@payer.test',
      isBilling: true,
    });
    const invoiceId = await makeInvoice();
    const router = buildRouter({ sendEmail: async () => undefined });
    await invokeLast(
      router,
      'post',
      '/:id/pay-link/send',
      staffReq(invoiceId, { channel: 'EMAIL' }),
    );
    // second send 24h-cooldown blocks the email but still mints a new link;
    // the prior link stays ACTIVE so a client holding it can still pay.
    const second = await invokeLast(
      router,
      'post',
      '/:id/pay-link/send',
      staffReq(invoiceId, { channel: 'EMAIL' }),
    );
    expect(second.jsonBody.results!.email).toBe('cooldown');
    const links = await harness.db
      .select()
      .from(invoicePayLinks)
      .where(eq(invoicePayLinks.invoiceId, invoiceId));
    expect(links.filter((l) => l.status === 'ACTIVE').length).toBe(2);
    expect(links.filter((l) => l.status === 'VOIDED').length).toBe(0);
  });

  it('the dunning reminder email now carries a no-login pay-link', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Payer',
      email: 'pat@payer.test',
      isBilling: true,
    });
    const invoiceId = await makeInvoice();
    let body = '';
    const router = buildRouter({
      sendEmail: async (a) => {
        body = a.body;
      },
    });
    const res = await invokeLast(router, 'post', '/:id/remind', staffReq(invoiceId, {}));
    expect(res.statusCode).toBe(200);
    expect(body).toContain('https://pay.firm.test/pay/');
    // a payable link was minted for the invoice
    const links = await harness.db
      .select()
      .from(invoicePayLinks)
      .where(eq(invoicePayLinks.invoiceId, invoiceId));
    expect(links.filter((l) => l.status === 'ACTIVE').length).toBe(1);
  });

  it('reminder still includes the pay-link when the saved template lacks {{ invoice.pay_url }}', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Payer',
      email: 'pat@payer.test',
      isBilling: true,
    });
    const invoiceId = await makeInvoice();
    // Pre-0181 override template: portal_url only, NO pay_url. The DB override
    // wins over the inline fallback — the handler must still append the link.
    await harness.db.insert(notificationTemplates).values({
      firmId: seed.firmId,
      kind: 'invoice_overdue',
      channel: 'EMAIL',
      subject: 'Past due {{ invoice.number }}',
      body: 'Balance {{ invoice.balance }}. View in portal: {{ invoice.portal_url }}',
      enabled: true,
    });
    let body = '';
    const router = buildRouter({
      sendEmail: async (a) => {
        body = a.body;
      },
    });
    const res = await invokeLast(router, 'post', '/:id/remind', staffReq(invoiceId, {}));
    expect(res.statusCode).toBe(200);
    expect(body).toContain('https://pay.firm.test/pay/');
    expect(body).toContain('Pay now (no login required)');
  });

  it('revoke voids the active link', async () => {
    const invoiceId = await makeInvoice();
    await createPayLink(harness.db, { firmId: seed.firmId, invoiceId });
    const router = buildRouter({});
    const res = await invokeLast(router, 'post', '/:id/pay-link/revoke', staffReq(invoiceId, {}));
    expect(res.statusCode).toBe(200);
    const links = await harness.db
      .select()
      .from(invoicePayLinks)
      .where(eq(invoicePayLinks.invoiceId, invoiceId));
    expect(links.every((l) => l.status === 'VOIDED')).toBe(true);
  });
});
