// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Manual ACH bank capture — the client (or staff, from a paper authorization)
// enters a routing + account number directly instead of logging into the bank.
// Stripe verifies ownership asynchronously via micro-deposits (1-2 business
// days), so the saved method starts in verification_status='PENDING_MICRODEPOSIT'
// and is NOT chargeable until verifyMicrodeposits() clears it.
//
// Flow (all server-side, no browser Elements needed):
//   1. POST /v1/payment_methods (type=us_bank_account, routing+account)
//   2. POST /v1/setup_intents (confirm=true, verification_method=microdeposits,
//      offline mandate) → status requires_action, micro-deposits sent
//   3. persist a PENDING_MICRODEPOSIT payment_method row
//   4. later: POST /v1/setup_intents/{id}/verify_microdeposits → succeeded →
//      clear verification_status (now chargeable)

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { paymentMethod, stripeCustomers } from '@vibe/db/schema';

import { resolveFirmStripe } from './firm-stripe';
import { clientBillingIdentity } from './saved-methods';
import { getOrCreateCustomer, captureAchMandate } from '../stripe-connect/setup-intent';
import { stripePostForm } from '../stripe-connect/raw';

export interface CreateManualAchInput {
  db: Database;
  firmId: string;
  clientId: string;
  routingNumber: string;
  accountNumber: string;
  accountHolderType: 'individual' | 'company';
  accountHolderName: string;
  portalIdentityId?: string | null;
  fetchImpl?: typeof fetch;
}

export type CreateManualAchResult =
  | { ok: true; paymentMethodId: string; verification: 'microdeposit_pending' | 'verified' }
  | { ok: false; error: string };

export async function createManualAchMethod(
  input: CreateManualAchInput,
): Promise<CreateManualAchResult> {
  const creds = await resolveFirmStripe(input.db, input.firmId);
  if (!creds) return { ok: false, error: 'stripe_not_configured' };
  const ident = await clientBillingIdentity(input.db, input.firmId, input.clientId);
  if (!ident) return { ok: false, error: 'client_not_found' };

  const { stripeCustomerId } = await getOrCreateCustomer({
    db: input.db,
    firmId: input.firmId,
    clientId: input.clientId,
    secretKey: creds.secretKey,
    stripeAccountId: creds.stripeAccountId,
    email: ident.email,
    name: input.accountHolderName || ident.name,
    fetchImpl: input.fetchImpl,
  });

  let pmId: string;
  let bankLast4 = '••••';
  let bankName: string | null = null;
  try {
    const pm = await stripePostForm({
      secretKey: creds.secretKey,
      stripeAccountId: creds.stripeAccountId,
      path: '/payment_methods',
      params: {
        type: 'us_bank_account',
        'us_bank_account[account_number]': input.accountNumber,
        'us_bank_account[routing_number]': input.routingNumber,
        'us_bank_account[account_holder_type]': input.accountHolderType,
        'billing_details[name]': input.accountHolderName || ident.name,
        ...(ident.email ? { 'billing_details[email]': ident.email } : {}),
      },
      fetchImpl: input.fetchImpl,
    });
    pmId = String(pm['id']);
    const acct = pm['us_bank_account'] as { last4?: string; bank_name?: string } | undefined;
    bankLast4 = acct?.last4 ?? '••••';
    bankName = acct?.bank_name ?? null;
  } catch (err) {
    return { ok: false, error: stripeMessage(err) };
  }

  // Attach + start verification via a confirmed SetupIntent. Offline mandate
  // acceptance records the client's NACHA authorization for MIT debits.
  let setupIntentId: string;
  let mandateId: string | null = null;
  let status: string;
  try {
    const si = await stripePostForm({
      secretKey: creds.secretKey,
      stripeAccountId: creds.stripeAccountId,
      path: '/setup_intents',
      params: {
        customer: stripeCustomerId,
        payment_method: pmId,
        'payment_method_types[0]': 'us_bank_account',
        usage: 'off_session',
        confirm: 'true',
        'payment_method_options[us_bank_account][verification_method]': 'microdeposits',
        'mandate_data[customer_acceptance][type]': 'offline',
      },
      fetchImpl: input.fetchImpl,
    });
    setupIntentId = String(si['id']);
    mandateId = si['mandate'] ? String(si['mandate']) : null;
    status = String(si['status']);
  } catch (err) {
    return { ok: false, error: stripeMessage(err) };
  }

  const verified = status === 'succeeded';
  const displayLabel = `${bankName ?? 'Bank'} ····${bankLast4}`;

  // Idempotency — don't double-insert the same PaymentMethod.
  const [dup] = await input.db
    .select({ id: paymentMethod.id })
    .from(paymentMethod)
    .where(eq(paymentMethod.providerToken, pmId))
    .limit(1);
  if (dup) {
    return {
      ok: true,
      paymentMethodId: dup.id,
      verification: verified ? 'verified' : 'microdeposit_pending',
    };
  }

  // Ensure the local stripe_customers row exists (idempotent).
  const [existsCust] = await input.db
    .select({ id: stripeCustomers.id })
    .from(stripeCustomers)
    .where(
      and(eq(stripeCustomers.firmId, input.firmId), eq(stripeCustomers.clientId, input.clientId)),
    )
    .limit(1);
  if (!existsCust) {
    await input.db.insert(stripeCustomers).values({
      firmId: input.firmId,
      clientId: input.clientId,
      stripeAccountId: creds.stripeAccountId || 'direct',
      stripeCustomerId,
    });
  }

  const [row] = await input.db
    .insert(paymentMethod)
    .values({
      firmId: input.firmId,
      clientId: input.clientId,
      portalIdentityId: input.portalIdentityId ?? null,
      kind: 'ACH',
      provider: 'STRIPE',
      providerToken: pmId,
      providerCustomerId: stripeCustomerId,
      lastFour: bankLast4,
      displayLabel,
      brand: bankName,
      status: 'ACTIVE',
      verificationStatus: verified ? null : 'PENDING_MICRODEPOSIT',
      pendingSetupIntentId: verified ? null : setupIntentId,
    })
    .returning({ id: paymentMethod.id });
  const paymentMethodId = row!.id;

  if (mandateId) {
    await captureAchMandate({
      db: input.db,
      firmId: input.firmId,
      clientId: input.clientId,
      proposalId: null,
      stripeAccountId: creds.stripeAccountId || 'direct',
      stripeCustomerId,
      stripePaymentMethodId: pmId,
      stripeMandateId: mandateId,
      mandateTextRendered: `ACH debit authorization — ${displayLabel} (manual entry, ${input.accountHolderType})`,
      paymentMethodId,
    }).catch(() => undefined);
  }

  return {
    ok: true,
    paymentMethodId,
    verification: verified ? 'verified' : 'microdeposit_pending',
  };
}

export interface VerifyMicrodepositsInput {
  db: Database;
  firmId: string;
  clientId: string;
  paymentMethodId: string;
  amounts?: [number, number]; // two micro-deposit amounts in cents
  descriptorCode?: string; // or the SM<code> descriptor from the statement
  fetchImpl?: typeof fetch;
}

export async function verifyMicrodeposits(
  input: VerifyMicrodepositsInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const creds = await resolveFirmStripe(input.db, input.firmId);
  if (!creds) return { ok: false, error: 'stripe_not_configured' };

  const [pm] = await input.db
    .select()
    .from(paymentMethod)
    .where(
      and(
        eq(paymentMethod.id, input.paymentMethodId),
        eq(paymentMethod.firmId, input.firmId),
        eq(paymentMethod.clientId, input.clientId),
      ),
    )
    .limit(1);
  if (!pm) return { ok: false, error: 'payment_method_not_found' };
  if (!pm.pendingSetupIntentId || pm.verificationStatus !== 'PENDING_MICRODEPOSIT') {
    return { ok: false, error: 'not_pending_verification' };
  }
  if (!input.amounts && !input.descriptorCode) {
    return { ok: false, error: 'amounts_or_descriptor_required' };
  }

  try {
    const params: Record<string, string> = {};
    if (input.descriptorCode) {
      params['descriptor_code'] = input.descriptorCode;
    } else if (input.amounts) {
      params['amounts[0]'] = String(input.amounts[0]);
      params['amounts[1]'] = String(input.amounts[1]);
    }
    const si = await stripePostForm({
      secretKey: creds.secretKey,
      stripeAccountId: creds.stripeAccountId,
      path: `/setup_intents/${pm.pendingSetupIntentId}/verify_microdeposits`,
      params,
      fetchImpl: input.fetchImpl,
    });
    if (String(si['status']) !== 'succeeded') {
      return { ok: false, error: `setup_intent_${String(si['status'])}` };
    }
  } catch (err) {
    return { ok: false, error: stripeMessage(err) };
  }

  await input.db
    .update(paymentMethod)
    .set({ verificationStatus: null, pendingSetupIntentId: null, updatedAt: new Date() })
    .where(eq(paymentMethod.id, pm.id));
  return { ok: true };
}

function stripeMessage(err: unknown): string {
  const code = (err as { stripeCode?: string })?.stripeCode;
  if (code) return `stripe_${code}`;
  return err instanceof Error ? 'stripe_error' : 'stripe_error';
}
