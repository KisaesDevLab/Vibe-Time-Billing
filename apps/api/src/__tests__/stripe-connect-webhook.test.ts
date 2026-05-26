// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P12 — Stripe Connect webhook receiver tests.
//
// We bypass real Stripe by stubbing verifyWebhookSignature on a fake
// PaymentProvider. Idempotency is exercised by replaying the same
// event id; handler routing by feeding different event types.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  firmSettingsProposals,
  paymentMandates,
  stripeInvoices,
  stripeSubscriptions,
  webhookEvents,
} from '@vibe/db/schema';
import type { PaymentProvider } from '@vibe/core/payments';

import { createStripeConnectWebhookRouter } from '../webhooks/stripe-connect';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

const SECRET = 'whsec_test_secret';
const SIG_HEADER = 't=0,v1=stub';

function stubStripe(ok = true): PaymentProvider {
  // Only verifyWebhookSignature is exercised here; the other surface
  // throws if accidentally invoked.
  return {
    id: 'stripe',
    verifyWebhookSignature() {
      return ok;
    },
    charge() {
      throw new Error('unused');
    },
    refund() {
      throw new Error('unused');
    },
    createIntent() {
      throw new Error('unused');
    },
  } as unknown as PaymentProvider;
}

function buildApp(stripe: PaymentProvider | null = stubStripe(true)) {
  const app = express();
  app.use(
    '/api/webhooks/stripe-connect',
    createStripeConnectWebhookRouter({
      db: harness.db,
      stripe,
      webhookSecret: SECRET,
    }),
  );
  return app;
}

async function withFirm(stripeAccountId: string): Promise<{ firmId: string }> {
  const seed = await seedMinimalFirm(harness.db);
  // Connect the firm to a fake Stripe account so dispatch can find it.
  await harness.db.insert(firmSettingsProposals).values({
    firmId: seed.firmId,
    stripeAccountId,
    stripeConnectedAt: new Date(),
  });
  return { firmId: seed.firmId };
}

describe('P12 — signature gate', () => {
  it('401 on invalid signature', async () => {
    const app = buildApp(stubStripe(false));
    const res = await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', SIG_HEADER)
      .send(JSON.stringify({ id: 'evt_x', type: 'account.updated', data: { object: {} } }));
    expect(res.status).toBe(401);
  });

  it('400 missing signature header', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_x', type: 'account.updated', data: { object: {} } }));
    expect(res.status).toBe(400);
  });

  it('400 malformed event (missing id)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', SIG_HEADER)
      .send(JSON.stringify({ type: 'x', data: { object: {} } }));
    expect(res.status).toBe(400);
  });

  it('503 when secret not configured', async () => {
    const app = express();
    app.use(
      '/api/webhooks/stripe-connect',
      createStripeConnectWebhookRouter({
        db: harness.db,
        stripe: stubStripe(),
        webhookSecret: null,
      }),
    );
    const res = await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(503);
  });
});

describe('P12 — idempotency', () => {
  it('replays of the same event id do not reprocess', async () => {
    await withFirm('acct_dup');
    const app = buildApp();
    const event = {
      id: 'evt_dup_1',
      type: 'account.updated',
      account: 'acct_dup',
      data: {
        object: {
          id: 'acct_dup',
          capabilities: { card_payments: 'active' },
        },
      },
    };
    const first = await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', SIG_HEADER)
      .send(JSON.stringify(event));
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();
    const second = await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', SIG_HEADER)
      .send(JSON.stringify(event));
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    // Single row in webhook_events.
    const rows = await harness.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, 'evt_dup_1'));
    expect(rows.length).toBe(1);
    expect(rows[0]!.state).toBe('PROCESSED');
  });
});

describe('P12 — account.updated', () => {
  it('caches capabilities onto firm_settings_proposals', async () => {
    const { firmId } = await withFirm('acct_caps');
    const app = buildApp();
    await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', SIG_HEADER)
      .send(
        JSON.stringify({
          id: 'evt_acct_1',
          type: 'account.updated',
          account: 'acct_caps',
          data: {
            object: {
              id: 'acct_caps',
              capabilities: { card_payments: 'active', us_bank_account_ach_payments: 'pending' },
            },
          },
        }),
      );
    const [row] = await harness.db
      .select()
      .from(firmSettingsProposals)
      .where(eq(firmSettingsProposals.firmId, firmId));
    expect(row!.stripeAccountCapabilities).toMatchObject({
      card_payments: 'active',
      us_bank_account_ach_payments: 'pending',
    });
    const [evt] = await harness.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, 'evt_acct_1'));
    expect(evt!.firmId).toBe(firmId);
    expect(evt!.state).toBe('PROCESSED');
  });
});

describe('P12 — invoice.paid', () => {
  it('marks stripe_invoices row paid + records amounts', async () => {
    const { firmId } = await withFirm('acct_inv');
    // Seed a stripe_invoices row in DRAFT.
    const seedRes = await harness.db
      .insert(stripeInvoices)
      .values({
        firmId,
        stripeAccountId: 'acct_inv',
        stripeCustomerId: 'cus_x',
        stripeInvoiceId: 'in_test',
        stripeStatus: 'open',
      })
      .returning({ id: stripeInvoices.id });
    expect(seedRes.length).toBe(1);
    const app = buildApp();
    await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', SIG_HEADER)
      .send(
        JSON.stringify({
          id: 'evt_inv_paid',
          type: 'invoice.paid',
          account: 'acct_inv',
          data: {
            object: {
              id: 'in_test',
              status: 'paid',
              amount_due: 50000,
              amount_paid: 50000,
              amount_remaining: 0,
            },
          },
        }),
      );
    const [row] = await harness.db
      .select()
      .from(stripeInvoices)
      .where(eq(stripeInvoices.stripeInvoiceId, 'in_test'));
    expect(row!.stripeStatus).toBe('paid');
    expect(Number(row!.amountDueCents)).toBe(50000);
    expect(Number(row!.amountPaidCents)).toBe(50000);
    expect(row!.paidAt).not.toBeNull();
  });
});

describe('P12 — customer.subscription.updated', () => {
  it('mirrors stripe status onto stripe_subscriptions', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.insert(firmSettingsProposals).values({
      firmId: seed.firmId,
      stripeAccountId: 'acct_sub',
      stripeConnectedAt: new Date(),
    });
    await harness.db.insert(stripeSubscriptions).values({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      stripeAccountId: 'acct_sub',
      stripeCustomerId: 'cus_x',
      stripeSubscriptionId: 'sub_test',
      stripeStatus: 'trialing',
    });
    const app = buildApp();
    await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', SIG_HEADER)
      .send(
        JSON.stringify({
          id: 'evt_sub_upd',
          type: 'customer.subscription.updated',
          account: 'acct_sub',
          data: {
            object: {
              id: 'sub_test',
              status: 'active',
              current_period_start: 1_700_000_000,
              current_period_end: 1_700_086_400,
            },
          },
        }),
      );
    const [row] = await harness.db
      .select()
      .from(stripeSubscriptions)
      .where(eq(stripeSubscriptions.stripeSubscriptionId, 'sub_test'));
    expect(row!.stripeStatus).toBe('active');
    expect(row!.currentPeriodStart).not.toBeNull();
  });

  it('subscription.deleted stamps cancelled_at', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.insert(stripeSubscriptions).values({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      stripeAccountId: 'acct_sub2',
      stripeCustomerId: 'cus_x',
      stripeSubscriptionId: 'sub_del',
      stripeStatus: 'active',
    });
    const app = buildApp();
    await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', SIG_HEADER)
      .send(
        JSON.stringify({
          id: 'evt_sub_del',
          type: 'customer.subscription.deleted',
          account: 'acct_sub2',
          data: { object: { id: 'sub_del', status: 'canceled' } },
        }),
      );
    const [row] = await harness.db
      .select()
      .from(stripeSubscriptions)
      .where(eq(stripeSubscriptions.stripeSubscriptionId, 'sub_del'));
    expect(row!.stripeStatus).toBe('canceled');
    expect(row!.cancelledAt).not.toBeNull();
  });
});

describe('P12 — mandate.updated', () => {
  it('maps stripe status to ACTIVE/INVALID/PENDING_VERIFICATION', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.insert(paymentMandates).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      kind: 'ACH',
      stripeAccountId: 'acct_m',
      stripeMandateId: 'mandate_test',
      mandateTextRendered: 'I authorize…',
      mandateTextHash: 'a'.repeat(64),
      state: 'PENDING_VERIFICATION',
    });
    const app = buildApp();
    await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', SIG_HEADER)
      .send(
        JSON.stringify({
          id: 'evt_mandate_1',
          type: 'mandate.updated',
          account: 'acct_m',
          data: { object: { id: 'mandate_test', status: 'active' } },
        }),
      );
    const [row] = await harness.db
      .select()
      .from(paymentMandates)
      .where(eq(paymentMandates.stripeMandateId, 'mandate_test'));
    expect(row!.state).toBe('ACTIVE');
    expect(row!.activatedAt).not.toBeNull();
  });
});

describe('P12 — unhandled type', () => {
  it('marks the event IGNORED but still returns 200', async () => {
    const { firmId } = await withFirm('acct_ig');
    const app = buildApp();
    const res = await request(app)
      .post('/api/webhooks/stripe-connect')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', SIG_HEADER)
      .send(
        JSON.stringify({
          id: 'evt_unhandled',
          type: 'something.we_dont_handle_yet',
          account: 'acct_ig',
          data: { object: {} },
        }),
      );
    expect(res.status).toBe(200);
    const [row] = await harness.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, 'evt_unhandled'));
    expect(row!.state).toBe('IGNORED');
    expect(row!.firmId).toBe(firmId);
  });
});
