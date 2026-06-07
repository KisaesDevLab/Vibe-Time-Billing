// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Scheduled payment retry (Phase 10 #28). For autopay charges that
// failed, retry on day 3, day 7, day 14 after the first failure.
// After the third failure (day 14 attempt), give up; the plan's
// auto-pause threshold has likely already kicked in via the recurring
// tick's consecutive-failure counter.
//
// Idempotency: the job reads payments WHERE status='FAILED' AND
// next_retry_at <= now() AND retry_count < 3. Each attempt updates
// retry_count + next_retry_at atomically so a second worker run
// inside the same minute won't double-retry the same payment.

import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { achReturns, invoices, payments, recurringBillingPlans } from '@vibe/db/schema';
import { planAchRetry } from '@vibe/core/payments';

import type { Logger } from 'pino';

export interface PaymentRetryDeps {
  chargeInvoice?: (args: {
    invoiceId: string;
    paymentMethodProviderId: string;
    amountCents: number;
    metadata: Record<string, string>;
  }) => Promise<{ ok: boolean; providerChargeId?: string; errorMessage?: string }>;
}

const RETRY_DAYS = [3, 7, 14];
const MAX_RETRIES = RETRY_DAYS.length;

export async function runPaymentRetry(
  db: Database,
  log: Logger,
  deps: PaymentRetryDeps = {},
): Promise<{ scanned: number; retried: number; succeeded: number; gaveUp: number }> {
  if (!deps.chargeInvoice) {
    return { scanned: 0, retried: 0, succeeded: 0, gaveUp: 0 };
  }
  const due = await db
    .select({
      id: payments.id,
      invoiceId: payments.invoiceId,
      amountCents: payments.amountCents,
      paymentMethodId: payments.paymentMethodId,
      retryCount: payments.retryCount,
    })
    .from(payments)
    .where(
      and(
        eq(payments.status, 'FAILED'),
        isNotNull(payments.nextRetryAt),
        lte(payments.nextRetryAt, new Date()),
      ),
    )
    .limit(200);
  if (due.length === 0) return { scanned: 0, retried: 0, succeeded: 0, gaveUp: 0 };

  let retried = 0;
  let succeeded = 0;
  let gaveUp = 0;
  for (const p of due) {
    if (p.retryCount >= MAX_RETRIES) {
      // Stop scheduling further retries; the autopay-pause threshold
      // on the recurring plan handles the user-facing pause.
      await db.update(payments).set({ nextRetryAt: null }).where(eq(payments.id, p.id));
      gaveUp++;
      continue;
    }
    retried++;
    // Look up the invoice to confirm it's still unpaid before charging.
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, p.invoiceId)).limit(1);
    if (!inv || inv.status === 'PAID' || inv.status === 'VOIDED') {
      // Underlying invoice was paid through another channel — close out.
      await db.update(payments).set({ nextRetryAt: null }).where(eq(payments.id, p.id));
      gaveUp++;
      continue;
    }
    if (!p.paymentMethodId) {
      // No saved method anymore (revoked); can't retry.
      await db.update(payments).set({ nextRetryAt: null }).where(eq(payments.id, p.id));
      gaveUp++;
      continue;
    }
    // Phase 21 — ACH returns honor NACHA: never retry no-auth/account codes;
    // cap at 2 retries within 40 days. Card payments have no ach_returns rows
    // and fall through to the card retry schedule unchanged.
    const achRets = await db
      .select({ code: achReturns.returnCode, createdAt: achReturns.createdAt })
      .from(achReturns)
      .where(eq(achReturns.paymentId, p.id))
      .orderBy(asc(achReturns.createdAt));
    if (achRets.length > 0) {
      const decision = planAchRetry({
        code: achRets[achRets.length - 1]!.code,
        retriesSoFar: p.retryCount,
        firstFailureAt: new Date(achRets[0]!.createdAt as unknown as string),
        now: new Date(),
      });
      if (!decision.retry) {
        await db.update(payments).set({ nextRetryAt: null }).where(eq(payments.id, p.id));
        gaveUp++;
        continue;
      }
    }
    try {
      const result = await deps.chargeInvoice({
        invoiceId: p.invoiceId,
        paymentMethodProviderId: p.paymentMethodId,
        amountCents: p.amountCents,
        metadata: {
          retry: 'true',
          retry_count: String(p.retryCount + 1),
        },
      });
      if (result.ok) {
        await db
          .update(payments)
          .set({
            status: 'SUCCEEDED',
            providerChargeId: result.providerChargeId ?? null,
            receivedAt: new Date(),
            retryCount: p.retryCount + 1,
            nextRetryAt: null,
          })
          .where(eq(payments.id, p.id));
        // Mirror what the stripe webhook would do: bump invoice paid.
        const newPaid = (inv.paidCents ?? 0) + p.amountCents;
        const newStatus = newPaid >= inv.totalCents ? 'PAID' : 'PARTIALLY_PAID';
        await db
          .update(invoices)
          .set({
            paidCents: newPaid,
            status: newStatus,
            paidAt: newStatus === 'PAID' ? new Date() : null,
          })
          .where(eq(invoices.id, inv.id));
        // Reset the recurring-plan failure counter so a fresh streak
        // doesn't tip back into auto-pause from a flake.
        if (inv.primaryEngagementId) {
          await db
            .update(recurringBillingPlans)
            .set({ consecutiveFailureCount: 0 })
            .where(eq(recurringBillingPlans.engagementId, inv.primaryEngagementId));
        }
        succeeded++;
        log.info({ paymentId: p.id, retryCount: p.retryCount + 1 }, 'autopay retry succeeded');
      } else {
        const nextRetryDays = RETRY_DAYS[p.retryCount + 1] ?? null;
        await db
          .update(payments)
          .set({
            retryCount: p.retryCount + 1,
            nextRetryAt:
              nextRetryDays != null ? new Date(Date.now() + nextRetryDays * 86_400_000) : null,
          })
          .where(eq(payments.id, p.id));
        log.warn(
          { paymentId: p.id, retryCount: p.retryCount + 1, err: result.errorMessage },
          'autopay retry failed',
        );
      }
    } catch (err) {
      const nextRetryDays = RETRY_DAYS[p.retryCount + 1] ?? null;
      await db
        .update(payments)
        .set({
          retryCount: p.retryCount + 1,
          nextRetryAt:
            nextRetryDays != null ? new Date(Date.now() + nextRetryDays * 86_400_000) : null,
        })
        .where(eq(payments.id, p.id));
      log.error({ err, paymentId: p.id }, 'autopay retry errored');
    }
  }
  return { scanned: due.length, retried, succeeded, gaveUp };
}
