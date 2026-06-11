// SPDX-License-Identifier: Elastic-2.0
//
// P09 + P10 + P11 — Stripe Payment Element + Subscription helper tests.
// All Stripe calls mocked via injected fetch.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { paymentMandates, stripeCustomers } from '@vibe/db/schema';
import {
  captureAchMandate,
  createDepositInvoice,
  createPrice,
  createSetupIntent,
  createSubscription,
  getOrCreateCustomer,
  mandateTextHash,
} from '../stripe-connect/setup-intent';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

function captureFetch(responses: Array<{ body: unknown; status?: number }>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; body: string; headers: Record<string, string> }>;
} {
  let i = 0;
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: String(init.body ?? ''),
      headers: (init.headers as Record<string, string>) ?? {},
    });
    const r = responses[i++] ?? { body: {}, status: 200 };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

describe('P09 — createSetupIntent', () => {
  it('POSTs /setup_intents with default payment_method_types', async () => {
    const { fetch, calls } = captureFetch([
      {
        body: {
          id: 'seti_test',
          client_secret: 'seti_test_secret',
          status: 'requires_payment_method',
        },
      },
    ]);
    const r = await createSetupIntent({
      secretKey: 'sk_test',
      stripeAccountId: 'acct_x',
      fetchImpl: fetch,
    });
    expect(r.id).toBe('seti_test');
    expect(r.clientSecret).toBe('seti_test_secret');
    expect(calls[0]!.url).toContain('/v1/setup_intents');
    expect(calls[0]!.body).toContain('payment_method_types%5B0%5D=card');
    expect(calls[0]!.body).toContain('payment_method_types%5B1%5D=us_bank_account');
    expect(calls[0]!.body).toContain('payment_method_types%5B2%5D=link');
    expect(calls[0]!.body).toContain('usage=off_session');
    expect(calls[0]!.headers['Stripe-Account']).toBe('acct_x');
  });

  it('honors customer + types override', async () => {
    const { fetch, calls } = captureFetch([
      { body: { id: 'seti_x', client_secret: 'cs', status: 'requires_action' } },
    ]);
    await createSetupIntent({
      secretKey: 'sk',
      stripeAccountId: 'acct_y',
      customerId: 'cus_123',
      paymentMethodTypes: ['card'],
      fetchImpl: fetch,
    });
    expect(calls[0]!.body).toContain('customer=cus_123');
    expect(calls[0]!.body).toContain('payment_method_types%5B0%5D=card');
    expect(calls[0]!.body).not.toContain('us_bank_account');
  });

  it('throws on Stripe error response', async () => {
    const { fetch } = captureFetch([{ body: { error: { message: 'bad keys' } }, status: 401 }]);
    await expect(
      createSetupIntent({ secretKey: 'sk', stripeAccountId: 'acct', fetchImpl: fetch }),
    ).rejects.toThrow(/bad keys/);
  });
});

describe('P10 — captureAchMandate', () => {
  it('hashes mandate text + inserts payment_mandates row', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const text = 'I authorize ACME CPAs to debit my account…';
    const id = await captureAchMandate({
      db: harness.db,
      firmId: seed.firmId,
      clientId: seed.clientId,
      proposalId: null,
      stripeAccountId: 'acct_a',
      stripeCustomerId: 'cus_a',
      stripePaymentMethodId: 'pm_a',
      stripeMandateId: 'mandate_a',
      mandateTextRendered: text,
    });
    const [row] = await harness.db.select().from(paymentMandates).where(eq(paymentMandates.id, id));
    expect(row!.mandateTextHash).toBe(mandateTextHash(text));
    expect(row!.state).toBe('PENDING_VERIFICATION');
    expect(row!.stripeMandateId).toBe('mandate_a');
  });

  it('mandateTextHash is deterministic', () => {
    const a = mandateTextHash('hello');
    const b = mandateTextHash('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('P11 — getOrCreateCustomer', () => {
  it('creates customer on first call + caches mapping', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const { fetch, calls } = captureFetch([{ body: { id: 'cus_new' } }]);
    const r1 = await getOrCreateCustomer({
      db: harness.db,
      firmId: seed.firmId,
      clientId: seed.clientId,
      secretKey: 'sk',
      stripeAccountId: 'acct',
      email: 'jane@x.com',
      name: 'Jane',
      fetchImpl: fetch,
    });
    expect(r1.created).toBe(true);
    expect(r1.stripeCustomerId).toBe('cus_new');
    expect(calls[0]!.headers['Idempotency-Key']).toBe(`cust-${seed.firmId}-${seed.clientId}-v1`);
    const [row] = await harness.db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.firmId, seed.firmId));
    expect(row!.stripeCustomerId).toBe('cus_new');
  });

  it('returns cached customer on second call without re-hitting Stripe', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const { fetch: fetch1 } = captureFetch([{ body: { id: 'cus_cached' } }]);
    await getOrCreateCustomer({
      db: harness.db,
      firmId: seed.firmId,
      clientId: seed.clientId,
      secretKey: 'sk',
      stripeAccountId: 'acct',
      email: 'jane@x.com',
      name: 'Jane',
      fetchImpl: fetch1,
    });
    // Second call: if it hits Stripe, the fetch stub will throw
    // because there are no responses queued. The cached path skips
    // the network entirely.
    const noNetwork: typeof fetch = (async () => {
      throw new Error('should_not_call_stripe');
    }) as unknown as typeof fetch;
    const r = await getOrCreateCustomer({
      db: harness.db,
      firmId: seed.firmId,
      clientId: seed.clientId,
      secretKey: 'sk',
      stripeAccountId: 'acct',
      email: 'jane@x.com',
      name: 'Jane',
      fetchImpl: noNetwork,
    });
    expect(r.created).toBe(false);
    expect(r.stripeCustomerId).toBe('cus_cached');
  });
});

describe('P11 — createPrice / createDepositInvoice / createSubscription', () => {
  it('createPrice posts product_data + unit_amount', async () => {
    const { fetch, calls } = captureFetch([{ body: { id: 'price_abc' } }]);
    const id = await createPrice({
      secretKey: 'sk',
      stripeAccountId: 'acct',
      productName: 'Monthly Bookkeeping',
      unitAmountCents: 50000,
      recurring: { interval: 'month' },
      fetchImpl: fetch,
    });
    expect(id).toBe('price_abc');
    expect(calls[0]!.body).toContain('unit_amount=50000');
    expect(calls[0]!.body).toContain('recurring%5Binterval%5D=month');
    expect(calls[0]!.body).toContain('product_data%5Bname%5D=Monthly+Bookkeeping');
  });

  it('createDepositInvoice walks invoice → item → finalize → pay', async () => {
    const { fetch, calls } = captureFetch([
      { body: { id: 'in_test' } }, // /invoices
      { body: { id: 'ii_test' } }, // /invoiceitems
      { body: { id: 'in_test', status: 'open' } }, // /invoices/in_test/finalize
      { body: { id: 'in_test', status: 'paid' } }, // /invoices/in_test/pay
    ]);
    const r = await createDepositInvoice({
      secretKey: 'sk',
      stripeAccountId: 'acct',
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      depositCents: 50000,
      description: 'Setup deposit',
      idempotencyKey: 'eng-1',
      fetchImpl: fetch,
    });
    expect(r.invoiceId).toBe('in_test');
    expect(r.status).toBe('paid');
    expect(calls).toHaveLength(4);
    expect(calls[0]!.url).toContain('/v1/invoices');
    expect(calls[1]!.url).toContain('/v1/invoiceitems');
    expect(calls[2]!.url).toContain('/finalize');
    expect(calls[3]!.url).toContain('/pay');
    // Idempotency keys distinct per step but rooted in the engagement
    // key so a retry hits the same Stripe transaction.
    expect(calls[0]!.headers['Idempotency-Key']).toBe('eng-1-invoice');
    expect(calls[1]!.headers['Idempotency-Key']).toBe('eng-1-item');
    expect(calls[2]!.headers['Idempotency-Key']).toBe('eng-1-finalize');
    expect(calls[3]!.headers['Idempotency-Key']).toBe('eng-1-pay');
  });

  it('createSubscription includes anchor + proration=none', async () => {
    const { fetch, calls } = captureFetch([{ body: { id: 'sub_test', status: 'active' } }]);
    const r = await createSubscription({
      secretKey: 'sk',
      stripeAccountId: 'acct',
      customerId: 'cus_x',
      paymentMethodId: 'pm_x',
      priceId: 'price_abc',
      billingCycleAnchor: 1_730_000_000,
      idempotencyKey: 'eng-1',
      fetchImpl: fetch,
    });
    expect(r.subscriptionId).toBe('sub_test');
    expect(r.status).toBe('active');
    expect(calls[0]!.body).toContain('proration_behavior=none');
    expect(calls[0]!.body).toContain('billing_cycle_anchor=1730000000');
    expect(calls[0]!.headers['Idempotency-Key']).toBe('eng-1-sub');
  });
});
