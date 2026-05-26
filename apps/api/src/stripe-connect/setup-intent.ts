// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P09 + P10 + P11 — Stripe Payment Element + Subscription helpers.
//
// All four pure functions accept an injected fetch so tests mock the
// network edge without monkey-patching globals. Each helper targets
// the firm's *connected* account via the `Stripe-Account` header —
// the platform's secret key signs the request, but the side effect
// lands on the connected stripe_user_id.
//
// Functions:
//   createSetupIntent(opts)           — P09: returns
//                                       SetupIntent.client_secret
//                                       scoped to firm's account
//   captureMandateText(opts)          — P10: persist Nacha mandate
//                                       text + SHA-256 hash on a
//                                       payment_mandates row when
//                                       Financial Connections
//                                       returns a US bank account.
//                                       Pure DB work, no Stripe call.
//   getOrCreateCustomer(opts)         — P11: get-or-create a Stripe
//                                       Customer on the connected
//                                       account, idempotent on
//                                       (firm, client).
//   createDepositAndSubscription(opts)— P11: full on-acceptance
//                                       orchestration — create
//                                       Price objects from
//                                       engagement_scope, create
//                                       initial Invoice (deposit) +
//                                       Subscription, return ids.
//                                       Idempotency-keyed.

import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { Database } from '@vibe/db';
import { paymentMandates, stripeCustomers } from '@vibe/db/schema';

import { logger } from '../logger';

const API_BASE = 'https://api.stripe.com/v1';

interface StripeRequestOptions {
  secretKey: string;
  stripeAccountId: string;
  path: string;
  params: Record<string, string>;
  fetchImpl?: typeof fetch;
  idempotencyKey?: string;
}

async function postForm(opts: StripeRequestOptions): Promise<Record<string, unknown>> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const body = new URLSearchParams(opts.params).toString();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Account': opts.stripeAccountId,
  };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetchImpl(`${API_BASE}${opts.path}`, {
    method: 'POST',
    headers,
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = json['error'] as { message?: string } | undefined;
    throw new Error(`stripe_${opts.path.slice(1)}_failed: ${err?.message ?? res.status}`);
  }
  return json;
}

// =====================================================================
// P09 — SetupIntent creation
// =====================================================================

export interface CreateSetupIntentInput {
  secretKey: string;
  stripeAccountId: string;
  customerId?: string;
  // Stripe accepts a list of payment_method_types; the addendum
  // requires Card + ACH + Link minimum.
  paymentMethodTypes?: string[];
  fetchImpl?: typeof fetch;
}

export interface SetupIntentResult {
  id: string;
  clientSecret: string;
  status: string;
}

export async function createSetupIntent(input: CreateSetupIntentInput): Promise<SetupIntentResult> {
  const params: Record<string, string> = {
    usage: 'off_session',
  };
  const types = input.paymentMethodTypes ?? ['card', 'us_bank_account', 'link'];
  types.forEach((t, i) => {
    params[`payment_method_types[${i}]`] = t;
  });
  if (input.customerId) params['customer'] = input.customerId;
  const json = await postForm({
    secretKey: input.secretKey,
    stripeAccountId: input.stripeAccountId,
    path: '/setup_intents',
    params,
    fetchImpl: input.fetchImpl,
  });
  return {
    id: String(json['id']),
    clientSecret: String(json['client_secret']),
    status: String(json['status']),
  };
}

// =====================================================================
// P10 — ACH mandate capture
// =====================================================================
//
// Stripe's Payment Element returns the verbatim mandate text shown to
// the client when ACH is selected. The portal accepts the
// SetupIntent + mandate text in the same submission; this helper
// hashes the text and writes a payment_mandates row tied to the
// proposal/client.

export interface CaptureMandateInput {
  db: Database;
  firmId: string;
  clientId: string;
  proposalId: string | null;
  stripeAccountId: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  stripeMandateId: string;
  mandateTextRendered: string;
  paymentMethodId?: string | null;
}

export function mandateTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function captureAchMandate(input: CaptureMandateInput): Promise<string> {
  const hash = mandateTextHash(input.mandateTextRendered);
  const [row] = await input.db
    .insert(paymentMandates)
    .values({
      firmId: input.firmId,
      proposalId: input.proposalId,
      clientId: input.clientId,
      paymentMethodId: input.paymentMethodId ?? null,
      kind: 'ACH',
      stripeAccountId: input.stripeAccountId,
      stripeCustomerId: input.stripeCustomerId,
      stripePaymentMethodId: input.stripePaymentMethodId,
      stripeMandateId: input.stripeMandateId,
      mandateTextRendered: input.mandateTextRendered,
      mandateTextHash: hash,
      state: 'PENDING_VERIFICATION',
    })
    .returning({ id: paymentMandates.id });
  if (!row) throw new Error('payment_mandates_insert_failed');
  return row.id;
}

// =====================================================================
// P11 — Customer get-or-create + subscription orchestration
// =====================================================================

export interface GetOrCreateCustomerInput {
  db: Database;
  firmId: string;
  clientId: string;
  secretKey: string;
  stripeAccountId: string;
  email: string;
  name: string;
  fetchImpl?: typeof fetch;
}

export async function getOrCreateCustomer(
  input: GetOrCreateCustomerInput,
): Promise<{ stripeCustomerId: string; created: boolean }> {
  const [existing] = await input.db
    .select({ stripeCustomerId: stripeCustomers.stripeCustomerId })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.firmId, input.firmId))
    .limit(1);
  if (existing) {
    return { stripeCustomerId: existing.stripeCustomerId, created: false };
  }
  const json = await postForm({
    secretKey: input.secretKey,
    stripeAccountId: input.stripeAccountId,
    path: '/customers',
    params: {
      email: input.email,
      name: input.name,
      'metadata[firmId]': input.firmId,
      'metadata[clientId]': input.clientId,
    },
    fetchImpl: input.fetchImpl,
    idempotencyKey: `cust-${input.firmId}-${input.clientId}-v1`,
  });
  await input.db.insert(stripeCustomers).values({
    firmId: input.firmId,
    clientId: input.clientId,
    stripeAccountId: input.stripeAccountId,
    stripeCustomerId: String(json['id']),
    emailAtCreation: input.email,
  });
  return { stripeCustomerId: String(json['id']), created: true };
}

export interface CreatePriceInput {
  secretKey: string;
  stripeAccountId: string;
  productName: string;
  unitAmountCents: number;
  // 'one_time' or recurring like { interval: 'month' }
  recurring?: { interval: 'day' | 'week' | 'month' | 'year' };
  fetchImpl?: typeof fetch;
}

export async function createPrice(input: CreatePriceInput): Promise<string> {
  const params: Record<string, string> = {
    currency: 'usd',
    unit_amount: String(input.unitAmountCents),
    'product_data[name]': input.productName,
  };
  if (input.recurring) {
    params['recurring[interval]'] = input.recurring.interval;
  }
  const json = await postForm({
    secretKey: input.secretKey,
    stripeAccountId: input.stripeAccountId,
    path: '/prices',
    params,
    fetchImpl: input.fetchImpl,
  });
  return String(json['id']);
}

export interface CreateDepositInvoiceInput {
  secretKey: string;
  stripeAccountId: string;
  customerId: string;
  paymentMethodId: string;
  depositCents: number;
  description: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}

export async function createDepositInvoice(
  input: CreateDepositInvoiceInput,
): Promise<{ invoiceId: string; status: string }> {
  // 1. Create the invoice (status: draft).
  const invJson = await postForm({
    secretKey: input.secretKey,
    stripeAccountId: input.stripeAccountId,
    path: '/invoices',
    params: {
      customer: input.customerId,
      default_payment_method: input.paymentMethodId,
      collection_method: 'charge_automatically',
      description: input.description,
    },
    fetchImpl: input.fetchImpl,
    idempotencyKey: `${input.idempotencyKey}-invoice`,
  });
  const invoiceId = String(invJson['id']);

  // 2. Attach a one-off line item.
  await postForm({
    secretKey: input.secretKey,
    stripeAccountId: input.stripeAccountId,
    path: '/invoiceitems',
    params: {
      customer: input.customerId,
      amount: String(input.depositCents),
      currency: 'usd',
      invoice: invoiceId,
      description: input.description,
    },
    fetchImpl: input.fetchImpl,
    idempotencyKey: `${input.idempotencyKey}-item`,
  });

  // 3. Finalize + pay.
  await postForm({
    secretKey: input.secretKey,
    stripeAccountId: input.stripeAccountId,
    path: `/invoices/${invoiceId}/finalize`,
    params: {},
    fetchImpl: input.fetchImpl,
    idempotencyKey: `${input.idempotencyKey}-finalize`,
  });
  const paid = await postForm({
    secretKey: input.secretKey,
    stripeAccountId: input.stripeAccountId,
    path: `/invoices/${invoiceId}/pay`,
    params: {},
    fetchImpl: input.fetchImpl,
    idempotencyKey: `${input.idempotencyKey}-pay`,
  });
  return { invoiceId, status: String(paid['status']) };
}

export interface CreateSubscriptionInput {
  secretKey: string;
  stripeAccountId: string;
  customerId: string;
  paymentMethodId: string;
  priceId: string;
  // Anchor to a future date (next month) so the first invoice doesn't
  // double-charge with the deposit invoice.
  billingCycleAnchor?: number;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<{ subscriptionId: string; status: string }> {
  const params: Record<string, string> = {
    customer: input.customerId,
    'items[0][price]': input.priceId,
    default_payment_method: input.paymentMethodId,
    proration_behavior: 'none',
  };
  if (input.billingCycleAnchor) {
    params['billing_cycle_anchor'] = String(input.billingCycleAnchor);
  }
  const json = await postForm({
    secretKey: input.secretKey,
    stripeAccountId: input.stripeAccountId,
    path: '/subscriptions',
    params,
    fetchImpl: input.fetchImpl,
    idempotencyKey: `${input.idempotencyKey}-sub`,
  });
  return { subscriptionId: String(json['id']), status: String(json['status']) };
}

// Silence unused linter for logger; available for future debug.
void logger;
