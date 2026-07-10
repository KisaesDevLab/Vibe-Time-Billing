// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Saved payment methods (card / ACH bank) for a client, on the firm's Stripe
// connected account. Flow:
//   1. createClientSetupIntent → returns a SetupIntent client_secret + the
//      publishable key/account for the browser Stripe.js.
//   2. the browser confirms the SetupIntent (Payment Element).
//   3. confirmClientSetupIntent → server retrieves the SetupIntent + its
//      PaymentMethod and persists a `payment_method` row (+ stripe_customers,
//      + an ACH mandate record). Idempotent on the provider token.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientContacts, clients, paymentMethod, persons, stripeCustomers } from '@vibe/db/schema';

import { resolveFirmStripe } from './firm-stripe';
import {
  createSetupIntent,
  getOrCreateCustomer,
  captureAchMandate,
} from '../stripe-connect/setup-intent';
import { stripeGet } from '../stripe-connect/raw';

export interface SavedMethodView {
  id: string;
  kind: 'CARD' | 'ACH';
  brand: string | null;
  lastFour: string;
  displayLabel: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
  verificationStatus: 'PENDING_MICRODEPOSIT' | null;
}

/** The billing email + name to attach to the Stripe Customer. */
export async function clientBillingIdentity(
  db: Database,
  firmId: string,
  clientId: string,
): Promise<{ email: string; name: string } | null> {
  const [c] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  if (!c) return null;
  const contacts = await db
    .select({
      email: persons.email,
      isPrimary: clientContacts.isPrimary,
      isBilling: clientContacts.isBilling,
      status: clientContacts.status,
    })
    .from(clientContacts)
    .innerJoin(persons, eq(persons.id, clientContacts.personId))
    .where(eq(clientContacts.clientId, clientId));
  const active = contacts.filter((x) => x.status === 'ACTIVE' && x.email);
  const pick = active.find((x) => x.isBilling) || active.find((x) => x.isPrimary) || active[0];
  return { email: pick?.email ?? '', name: c.name };
}

export interface CreateSetupIntentResult {
  setupIntentId: string;
  clientSecret: string;
  publishableKey: string;
  stripeAccountId: string;
}

/** Begin a save-a-method flow for a client. `portalIdentityId` is set when a
 *  portal user saves their own method; null for staff-saved. */
export async function createClientSetupIntent(
  db: Database,
  firmId: string,
  clientId: string,
  opts: {
    portalIdentityId?: string | null;
    achVerificationMethod?: 'automatic' | 'instant' | 'microdeposits';
    fetchImpl?: typeof fetch;
  } = {},
): Promise<CreateSetupIntentResult | { error: string }> {
  const creds = await resolveFirmStripe(db, firmId);
  if (!creds) return { error: 'stripe_not_configured' };
  const ident = await clientBillingIdentity(db, firmId, clientId);
  if (!ident) return { error: 'client_not_found' };

  const { stripeCustomerId } = await getOrCreateCustomer({
    db,
    firmId,
    clientId,
    secretKey: creds.secretKey,
    stripeAccountId: creds.stripeAccountId,
    email: ident.email,
    name: ident.name,
    fetchImpl: opts.fetchImpl,
  });
  const si = await createSetupIntent({
    secretKey: creds.secretKey,
    stripeAccountId: creds.stripeAccountId,
    customerId: stripeCustomerId,
    paymentMethodTypes: ['card', 'us_bank_account'],
    achVerificationMethod: opts.achVerificationMethod,
    fetchImpl: opts.fetchImpl,
  });
  return {
    setupIntentId: si.id,
    clientSecret: si.clientSecret,
    publishableKey: creds.publishableKey,
    stripeAccountId: creds.stripeAccountId,
  };
}

interface StripePm {
  id: string;
  type: string;
  card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number };
  us_bank_account?: { bank_name?: string; last4?: string };
}

/** After the browser confirms the SetupIntent, persist the resulting method.
 *  `mandateText` (from the Payment Element) is required to store the ACH
 *  NACHA authorization. Idempotent on the provider token. */
export async function confirmClientSetupIntent(
  db: Database,
  firmId: string,
  clientId: string,
  setupIntentId: string,
  opts: { portalIdentityId?: string | null; mandateText?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true; paymentMethodId: string } | { ok: false; error: string }> {
  const creds = await resolveFirmStripe(db, firmId);
  if (!creds) return { ok: false, error: 'stripe_not_configured' };

  const si = await stripeGet({
    secretKey: creds.secretKey,
    stripeAccountId: creds.stripeAccountId,
    path: `/setup_intents/${setupIntentId}`,
    params: { 'expand[0]': 'payment_method' },
    fetchImpl: opts.fetchImpl,
  });
  if (String(si['status']) !== 'succeeded') {
    return { ok: false, error: `setup_intent_${String(si['status'])}` };
  }
  const pm = si['payment_method'] as StripePm | null;
  const customerId = si['customer'] ? String(si['customer']) : null;
  const mandateId = si['mandate'] ? String(si['mandate']) : null;
  if (!pm || typeof pm !== 'object' || !pm.id) return { ok: false, error: 'no_payment_method' };

  const kind: 'CARD' | 'ACH' = pm.type === 'card' ? 'CARD' : 'ACH';
  const brand =
    kind === 'CARD' ? (pm.card?.brand ?? null) : (pm.us_bank_account?.bank_name ?? null);
  const lastFour = (kind === 'CARD' ? pm.card?.last4 : pm.us_bank_account?.last4) ?? '••••';
  const displayLabel = `${brand ?? (kind === 'CARD' ? 'Card' : 'Bank')} ····${lastFour}`;

  // Idempotent — a re-submit of the same SetupIntent must not double-insert.
  const [dup] = await db
    .select({ id: paymentMethod.id })
    .from(paymentMethod)
    .where(eq(paymentMethod.providerToken, pm.id))
    .limit(1);
  if (dup) return { ok: true, paymentMethodId: dup.id };

  // Ensure the local stripe_customers row exists (idempotent).
  if (customerId) {
    const [existsCust] = await db
      .select({ id: stripeCustomers.id })
      .from(stripeCustomers)
      .where(and(eq(stripeCustomers.firmId, firmId), eq(stripeCustomers.clientId, clientId)))
      .limit(1);
    if (!existsCust) {
      await db.insert(stripeCustomers).values({
        firmId,
        clientId,
        stripeAccountId: creds.stripeAccountId || 'direct',
        stripeCustomerId: customerId,
      });
    }
  }

  const [row] = await db
    .insert(paymentMethod)
    .values({
      firmId,
      clientId,
      portalIdentityId: opts.portalIdentityId ?? null,
      kind,
      provider: 'STRIPE',
      providerToken: pm.id,
      providerCustomerId: customerId,
      lastFour,
      displayLabel,
      brand,
      expMonth: kind === 'CARD' ? (pm.card?.exp_month ?? null) : null,
      expYear: kind === 'CARD' ? (pm.card?.exp_year ?? null) : null,
      status: 'ACTIVE',
    })
    .returning({ id: paymentMethod.id });
  const paymentMethodId = row!.id;

  // ACH: persist the NACHA mandate the client agreed to (text captured
  // client-side by the Payment Element). Best-effort — never blocks the save.
  if (kind === 'ACH' && mandateId && opts.mandateText && customerId) {
    await captureAchMandate({
      db,
      firmId,
      clientId,
      proposalId: null,
      stripeAccountId: creds.stripeAccountId || 'direct',
      stripeCustomerId: customerId,
      stripePaymentMethodId: pm.id,
      stripeMandateId: mandateId,
      mandateTextRendered: opts.mandateText,
      paymentMethodId,
    }).catch(() => undefined);
  }

  return { ok: true, paymentMethodId };
}

/** Active saved methods for a client (staff view). */
export async function listClientMethods(
  db: Database,
  firmId: string,
  clientId: string,
): Promise<SavedMethodView[]> {
  const rows = await db
    .select({
      id: paymentMethod.id,
      kind: paymentMethod.kind,
      brand: paymentMethod.brand,
      lastFour: paymentMethod.lastFour,
      displayLabel: paymentMethod.displayLabel,
      expMonth: paymentMethod.expMonth,
      expYear: paymentMethod.expYear,
      isDefault: paymentMethod.isDefault,
      verificationStatus: paymentMethod.verificationStatus,
    })
    .from(paymentMethod)
    .where(
      and(
        eq(paymentMethod.firmId, firmId),
        eq(paymentMethod.clientId, clientId),
        eq(paymentMethod.status, 'ACTIVE'),
      ),
    );
  return rows;
}
