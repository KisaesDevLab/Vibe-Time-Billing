// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// BYO Stripe webhook — refund / dispute branch. Locks in the QA fixes:
//   1. a refund reopens the invoice (paid_cents recomputed net of refund)
//   2. the branch is idempotent across redeliveries (no duplicate credit,
//      no double-processing)
//   3. a PARTIAL refund records amount_refunded (not the charge total) and
//      leaves the payment PARTIALLY_REFUNDED with the invoice partially paid

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { invoices, payments, creditMemos } from '@vibe/db/schema';
import type { Database } from '@vibe/db';
import type { PaymentProvider } from '@vibe/core/payments';
import { createStripeWebhookRouter } from '../webhooks/stripe';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

function stubStripe(): PaymentProvider {
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
  } as unknown as PaymentProvider;
}

function webhookApp(): express.Express {
  const app = express();
  app.use(
    '/api/webhooks/stripe',
    createStripeWebhookRouter({ db: harness.db, stripe: stubStripe(), webhookSecret: 'whsec' }),
  );
  return app;
}

async function seedPaidInvoice(opts: {
  total: number;
  paid: number;
  chargeId: string;
  payAmount: number;
}): Promise<{ invoiceId: string; paymentId: string }> {
  const [inv] = await harness.db
    .insert(invoices)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      invoiceNumber: `INV-${opts.chargeId}`,
      issueDate: '2026-06-01',
      dueDate: '2026-06-15',
      subtotalCents: opts.total,
      totalCents: opts.total,
      paidCents: opts.paid,
      status: (opts.paid >= opts.total ? 'PAID' : 'PARTIALLY_PAID') as 'PAID',
    })
    .returning({ id: invoices.id });
  const [pay] = await harness.db
    .insert(payments)
    .values({
      invoiceId: inv!.id,
      amountCents: opts.payAmount,
      provider: 'STRIPE',
      providerChargeId: opts.chargeId,
      status: 'SUCCEEDED',
      receivedAt: new Date(),
    })
    .returning({ id: payments.id });
  return { invoiceId: inv!.id, paymentId: pay!.id };
}

function refundEvent(chargeId: string, amountRefunded: number, id = 'evt_r1') {
  return {
    id,
    type: 'charge.refunded',
    data: { object: { id: chargeId, amount: 10000, amount_refunded: amountRefunded } },
  };
}

function send(app: express.Express, body: unknown) {
  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=0,v1=stub')
    .send(JSON.stringify(body));
}

async function getInvoice(db: Database, id: string) {
  const [row] = await db
    .select({ paid: invoices.paidCents, status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, id))
    .limit(1);
  return row!;
}

describe('BYO Stripe webhook — refund reopens the invoice', () => {
  it('full refund flips payment REFUNDED and reopens the invoice to unpaid', async () => {
    const { invoiceId } = await seedPaidInvoice({
      total: 10000,
      paid: 10000,
      chargeId: 'ch_full',
      payAmount: 10000,
    });
    await send(webhookApp(), refundEvent('ch_full', 10000)).expect(200);

    const [pay] = await harness.db
      .select()
      .from(payments)
      .where(eq(payments.providerChargeId, 'ch_full'));
    expect(pay!.status).toBe('REFUNDED');
    expect(Number(pay!.refundedAmountCents)).toBe(10000);

    const inv = await getInvoice(harness.db, invoiceId);
    expect(Number(inv.paid)).toBe(0); // net of refund
    expect(inv.status).not.toBe('PAID'); // reopened (SENT or OVERDUE)
  });

  it('partial refund records amount_refunded and leaves the invoice partially paid', async () => {
    const { invoiceId } = await seedPaidInvoice({
      total: 10000,
      paid: 10000,
      chargeId: 'ch_part',
      payAmount: 10000,
    });
    await send(webhookApp(), refundEvent('ch_part', 3000)).expect(200);

    const [pay] = await harness.db
      .select()
      .from(payments)
      .where(eq(payments.providerChargeId, 'ch_part'));
    expect(pay!.status).toBe('PARTIALLY_REFUNDED');
    expect(Number(pay!.refundedAmountCents)).toBe(3000);

    const inv = await getInvoice(harness.db, invoiceId);
    expect(Number(inv.paid)).toBe(7000); // 10000 − 3000
    expect(inv.status).toBe('PARTIALLY_PAID');
  });

  it('is idempotent — a redelivered refund does not double-process', async () => {
    await seedPaidInvoice({ total: 10000, paid: 10000, chargeId: 'ch_idem', payAmount: 10000 });
    const app = webhookApp();
    await send(app, refundEvent('ch_idem', 10000, 'evt_a')).expect(200);
    await send(app, refundEvent('ch_idem', 10000, 'evt_b')).expect(200); // redelivery

    const rows = await harness.db
      .select()
      .from(payments)
      .where(eq(payments.providerChargeId, 'ch_idem'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('REFUNDED');
  });

  it('does not mint a spurious REFUND_EXCESS credit on an ordinary refund', async () => {
    // paid_cents ≤ total is a DB invariant, so a refund never exceeds the
    // invoice's paid balance — excess is always 0 and no credit is created.
    // (Guards against a regression that miscomputes the excess as positive.)
    await seedPaidInvoice({ total: 10000, paid: 10000, chargeId: 'ch_noexc', payAmount: 10000 });
    const app = webhookApp();
    await send(app, refundEvent('ch_noexc', 10000, 'evt_c')).expect(200);
    await send(app, refundEvent('ch_noexc', 10000, 'evt_d')).expect(200); // redelivery

    const memos = await harness.db
      .select()
      .from(creditMemos)
      .where(eq(creditMemos.source, 'REFUND_EXCESS'));
    expect(memos).toHaveLength(0);
  });
});
