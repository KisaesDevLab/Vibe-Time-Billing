// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Charge a client's saved payment method off-session (merchant-initiated) and
// spread the amount across open invoices. Records a PENDING payment_receipt
// (mode CHARGE) with the allocations, then confirms a PaymentIntent on the
// firm's connected account (card MIT with off_session, or ACH). Settlement —
// inserting the per-invoice `payment` rows and recomputing balances — is done
// by the shared webhook path `materializeReceiptIfPending`; for a card charge
// that returns 'succeeded' immediately we also settle synchronously (the
// webhook is the idempotent backstop). ACH stays PENDING until it settles or
// returns.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { paymentMethod, paymentReceipts, stripeCustomers } from '@vibe/db/schema';

import { resolveFirmStripe } from './firm-stripe';
import { draftAchOffSession, draftCardOffSession } from '../stripe-connect/off-session-draft';
import { materializeReceiptIfPending } from './settle-receipt';

export interface ChargeAllocation {
  invoiceId: string;
  amountCents: number;
}

export interface OffSessionChargeInput {
  db: Database;
  firmId: string;
  clientId: string;
  paymentMethodId: string;
  amountCents: number;
  allocations: ChargeAllocation[];
  /** YYYY-MM-DD receipt/payment date; defaults to today (UTC). */
  paymentDate?: string;
  createdById?: string | null;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export type OffSessionChargeResult =
  | {
      ok: true;
      receiptId: string;
      paymentIntentId: string;
      /** Stripe PI status: 'succeeded' (card) | 'processing' (ACH) | … */
      status: string;
      /** Card MIT needed SCA — the charge did not go through off-session. */
      requiresAction: boolean;
      /** Whether invoices were settled synchronously (immediate card success). */
      settled: boolean;
    }
  | { ok: false; error: string; receiptId?: string };

function todayYmd(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function chargeClientBalanceOffSession(
  input: OffSessionChargeInput,
): Promise<OffSessionChargeResult> {
  const { db, firmId, clientId } = input;
  if (input.amountCents <= 0) return { ok: false, error: 'amount_must_be_positive' };

  const creds = await resolveFirmStripe(db, firmId);
  if (!creds) return { ok: false, error: 'stripe_not_configured' };

  // Saved method — firm-scoped, ACTIVE.
  const [pm] = await db
    .select({
      kind: paymentMethod.kind,
      providerToken: paymentMethod.providerToken,
      providerCustomerId: paymentMethod.providerCustomerId,
      verificationStatus: paymentMethod.verificationStatus,
    })
    .from(paymentMethod)
    .where(
      and(
        eq(paymentMethod.id, input.paymentMethodId),
        eq(paymentMethod.firmId, firmId),
        eq(paymentMethod.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  if (!pm) return { ok: false, error: 'payment_method_not_found' };
  // A manual-ACH bank awaiting micro-deposit verification is not chargeable.
  if (pm.verificationStatus) return { ok: false, error: 'payment_method_unverified' };

  // Resolve the Stripe customer for this client.
  let customerId = pm.providerCustomerId;
  if (!customerId) {
    const [cust] = await db
      .select({ id: stripeCustomers.stripeCustomerId })
      .from(stripeCustomers)
      .where(and(eq(stripeCustomers.firmId, firmId), eq(stripeCustomers.clientId, clientId)))
      .limit(1);
    customerId = cust?.id ?? null;
  }
  if (!customerId) return { ok: false, error: 'stripe_customer_missing' };

  // PENDING receipt with the allocations the webhook/self-settle will apply.
  const [receipt] = await db
    .insert(paymentReceipts)
    .values({
      firmId,
      payerClientId: clientId,
      paymentDate: input.paymentDate ?? todayYmd(new Date()),
      reference: null,
      paymentMethod: pm.kind === 'CARD' ? 'CARD_STRIPE' : 'ACH_STRIPE',
      mode: 'CHARGE',
      totalCents: input.amountCents,
      provider: 'STRIPE',
      providerChargeId: null,
      status: 'PENDING',
      allocationsPending: input.allocations,
      createdById: input.createdById ?? null,
    })
    .returning({ id: paymentReceipts.id });
  if (!receipt) return { ok: false, error: 'receipt_insert_failed' };

  const draftInput = {
    secretKey: creds.secretKey,
    stripeAccountId: creds.stripeAccountId,
    customerId,
    paymentMethodId: pm.providerToken,
    amountCents: input.amountCents,
    currency: 'usd',
    metadata: { receiptId: receipt.id, firmId, clientId, ...(input.metadata ?? {}) },
    idempotencyKey: input.idempotencyKey,
    fetchImpl: input.fetchImpl,
  };

  let draft;
  try {
    draft =
      pm.kind === 'CARD'
        ? await draftCardOffSession(draftInput)
        : await draftAchOffSession(draftInput);
  } catch (err) {
    await db
      .update(paymentReceipts)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(eq(paymentReceipts.id, receipt.id))
      .catch(() => undefined);
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'charge_failed',
      receiptId: receipt.id,
    };
  }

  // Persist the PI id so the webhook settlement can find the receipt.
  if (draft.id) {
    await db
      .update(paymentReceipts)
      .set({ providerChargeId: draft.id, updatedAt: new Date() })
      .where(eq(paymentReceipts.id, receipt.id));
  }

  // Card SCA: the off-session charge did not complete — leave PENDING for a
  // caller-driven on-session recovery.
  if (draft.requiresAction) {
    return {
      ok: true,
      receiptId: receipt.id,
      paymentIntentId: draft.id,
      status: 'requires_action',
      requiresAction: true,
      settled: false,
    };
  }

  // Immediate card success → settle now (idempotent; webhook re-settles safely).
  let settled = false;
  if (draft.status === 'succeeded' && draft.id) {
    settled = await materializeReceiptIfPending(db, draft.id).catch(() => false);
  }
  return {
    ok: true,
    receiptId: receipt.id,
    paymentIntentId: draft.id,
    status: draft.status,
    requiresAction: false,
    settled,
  };
}
