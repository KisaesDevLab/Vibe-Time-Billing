// SPDX-License-Identifier: Elastic-2.0
//
// Phase 22 — ACH lifecycle reactions. When Stripe reports an ACH return
// (during processing as a failure, or later as a final dispute), record it
// and apply the NACHA-correct side effects:
//   - invalidate the standing mandate for no-authorization / account-error codes
//   - block (revoke) the saved bank payment method for account errors
//   - pause autopay schedules drafting against that method for any non-retriable
//     return (so the scheduler doesn't keep hammering a dead authorization)
//
// Pure DB orchestration (no Stripe calls) so it's unit-testable and safe to
// call from the webhook handler.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { achReturns, paymentMandates, paymentMethod, recurringBillingPlans } from '@vibe/db/schema';
import { classifyAchReturn, type AchReturnClassification } from '@vibe/core/payments';

export interface AchReturnInput {
  firmId: string;
  returnCode: string;
  paymentId?: string | null;
  invoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeChargeId?: string | null;
  stripePaymentMethodId?: string | null;
  amountCents?: number;
  feeCents?: number;
  source?: 'failure' | 'dispute';
  now?: Date;
}

export interface AchReturnReaction {
  achReturnId: string;
  classification: AchReturnClassification;
  mandateInvalidated: boolean;
  paymentMethodBlocked: boolean;
  plansPaused: number;
}

export async function recordAchReturnAndReact(
  db: Database,
  input: AchReturnInput,
): Promise<AchReturnReaction> {
  const now = input.now ?? new Date();
  const cls = classifyAchReturn(input.returnCode);

  const [row] = await db
    .insert(achReturns)
    .values({
      firmId: input.firmId,
      paymentId: input.paymentId ?? null,
      invoiceId: input.invoiceId ?? null,
      stripePaymentIntentId: input.stripePaymentIntentId ?? null,
      stripeChargeId: input.stripeChargeId ?? null,
      stripePaymentMethodId: input.stripePaymentMethodId ?? null,
      returnCode: cls.code,
      category: cls.category,
      retriable: cls.retriable,
      invalidatedMandate: cls.invalidatesMandate,
      blockedPaymentMethod: cls.blocksPaymentMethod,
      amountCents: input.amountCents ?? 0,
      feeCents: input.feeCents ?? 0,
      source: input.source ?? 'failure',
    })
    .returning({ id: achReturns.id });

  const stripePm = input.stripePaymentMethodId ?? null;
  let mandateInvalidated = false;
  let paymentMethodBlocked = false;
  let plansPaused = 0;

  // 1. Invalidate the mandate (no-auth / account-error) — re-authorization required.
  if (cls.invalidatesMandate && stripePm) {
    await db
      .update(paymentMandates)
      .set({
        state: 'INVALID',
        invalidatedAt: now,
        invalidatedReason: `ach_return:${cls.code}`,
      })
      .where(
        and(
          eq(paymentMandates.firmId, input.firmId),
          eq(paymentMandates.stripePaymentMethodId, stripePm),
        ),
      );
    mandateInvalidated = true;
  }

  // 2. Resolve the saved bank PM (provider token == Stripe pm id) and block it
  //    for account errors.
  let pmId: string | null = null;
  if (stripePm) {
    const [pm] = await db
      .select({ id: paymentMethod.id })
      .from(paymentMethod)
      .where(eq(paymentMethod.providerToken, stripePm))
      .limit(1);
    pmId = pm?.id ?? null;
    if (pmId && cls.blocksPaymentMethod) {
      await db
        .update(paymentMethod)
        .set({ status: 'REVOKED', updatedAt: now })
        .where(eq(paymentMethod.id, pmId));
      paymentMethodBlocked = true;
    }
  }

  // 3. Halt autopay schedules on this method for any non-retriable return.
  if (!cls.retriable && pmId) {
    const paused = await db
      .update(recurringBillingPlans)
      .set({ status: 'PAUSED', pausedAt: now })
      .where(
        and(
          eq(recurringBillingPlans.autoPayPaymentMethodId, pmId),
          eq(recurringBillingPlans.status, 'ACTIVE'),
        ),
      )
      .returning({ id: recurringBillingPlans.id });
    plansPaused = paused.length;
  }

  return {
    achReturnId: row!.id,
    classification: cls,
    mandateInvalidated,
    paymentMethodBlocked,
    plansPaused,
  };
}
