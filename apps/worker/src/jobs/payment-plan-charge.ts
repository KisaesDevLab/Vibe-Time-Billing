// SPDX-License-Identifier: Elastic-2.0
//
// Recurring installment payment plans (0192). Each ACTIVE plan due today is
// charged a fixed installment (capped at the client's current open balance),
// applied oldest-first across open invoices, off-session to the saved method.
// On success the schedule advances (or COMPLETES when the balance is cleared);
// on failure it backs off and pauses after `pause_threshold` consecutive
// failures. Charging + settlement are delegated to the injected `charge`
// service (the API's off-session charge), so this job is DB + scheduling only.

import { and, eq, lte, or, isNull, lt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { clientPaymentPlans } from '@vibe/db/schema';
import { nextRunDate } from '@vibe/core/billing';

import {
  loadOpenInvoicesOldestFirst,
  buildAllocations,
  outstandingCents,
  type Allocation,
} from '../../../api/src/payments/plan-allocation';

export interface PlanChargeOutcome {
  ok: boolean;
  paymentIntentId?: string;
  requiresAction?: boolean;
  error?: string;
}

export interface PaymentPlanChargeDeps {
  // Injected off-session charge (chargeClientBalanceOffSession bound to db).
  charge: (args: {
    firmId: string;
    clientId: string;
    paymentMethodId: string;
    amountCents: number;
    allocations: Allocation[];
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }) => Promise<PlanChargeOutcome>;
  // Best-effort notification when a plan pauses (partner email). Optional.
  onPaused?: (plan: { id: string; clientId: string; reason: string }) => Promise<void>;
}

export interface PaymentPlanChargeResult {
  due: number;
  charged: number;
  completed: number;
  failed: number;
  skipped: number;
}

// Retry backoff (days) by consecutive-failure count before the pause threshold.
const RETRY_BACKOFF_DAYS = [1, 3, 7];

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return dt.toISOString().slice(0, 10);
}

export async function runPaymentPlanChargeTick(
  db: Database,
  log: Logger,
  today?: string,
  deps?: PaymentPlanChargeDeps,
): Promise<PaymentPlanChargeResult> {
  const run: PaymentPlanChargeResult = { due: 0, charged: 0, completed: 0, failed: 0, skipped: 0 };
  if (!deps) return run;
  const day = today ?? new Date().toISOString().slice(0, 10);

  const duePlans = await db
    .select()
    .from(clientPaymentPlans)
    .where(and(eq(clientPaymentPlans.status, 'ACTIVE'), lte(clientPaymentPlans.nextRunDate, day)))
    .limit(500);
  run.due = duePlans.length;

  for (const plan of duePlans) {
    // Atomic same-day claim: a plan charged today can't be re-charged today.
    const claimed = await db
      .update(clientPaymentPlans)
      .set({ lastRunAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(clientPaymentPlans.id, plan.id),
          eq(clientPaymentPlans.status, 'ACTIVE'),
          lte(clientPaymentPlans.nextRunDate, day),
          or(
            isNull(clientPaymentPlans.lastRunAt),
            lt(sql`${clientPaymentPlans.lastRunAt}::date`, sql`${day}::date`),
          ),
        ),
      )
      .returning({ id: clientPaymentPlans.id });
    if (claimed.length === 0) {
      run.skipped += 1;
      continue;
    }

    try {
      const open = await loadOpenInvoicesOldestFirst(db, plan.firmId, plan.clientId);
      const outstanding = outstandingCents(open);
      if (outstanding <= 0) {
        // Nothing owed — the plan has done its job.
        await db
          .update(clientPaymentPlans)
          .set({ status: 'COMPLETED', updatedAt: new Date() })
          .where(eq(clientPaymentPlans.id, plan.id));
        run.completed += 1;
        continue;
      }
      const amount = Math.min(plan.installmentCents, outstanding);
      const allocations = buildAllocations(open, amount);

      const result = await deps.charge({
        firmId: plan.firmId,
        clientId: plan.clientId,
        paymentMethodId: plan.paymentMethodId,
        amountCents: amount,
        allocations,
        idempotencyKey: `payplan:${plan.id}:${day}`,
        metadata: { payment_plan_id: plan.id },
      });

      if (!result.ok || result.requiresAction) {
        const failCount = plan.consecutiveFailureCount + 1;
        if (failCount >= plan.pauseThreshold || result.requiresAction) {
          const reason = result.requiresAction ? 'authentication_required' : 'charge_failures';
          await db
            .update(clientPaymentPlans)
            .set({
              status: 'PAUSED',
              pausedReason: reason,
              consecutiveFailureCount: failCount,
              updatedAt: new Date(),
            })
            .where(eq(clientPaymentPlans.id, plan.id));
          await deps
            .onPaused?.({ id: plan.id, clientId: plan.clientId, reason })
            .catch(() => undefined);
        } else {
          const backoff =
            RETRY_BACKOFF_DAYS[Math.min(failCount - 1, RETRY_BACKOFF_DAYS.length - 1)]!;
          await db
            .update(clientPaymentPlans)
            .set({
              consecutiveFailureCount: failCount,
              nextRunDate: addDays(day, backoff),
              updatedAt: new Date(),
            })
            .where(eq(clientPaymentPlans.id, plan.id));
        }
        run.failed += 1;
        log.warn({ planId: plan.id, error: result.error }, 'payment-plan charge failed');
        continue;
      }

      // Success. If this installment covered the whole balance, the plan is
      // done; otherwise advance to the next cycle and clear the failure count.
      if (amount >= outstanding) {
        await db
          .update(clientPaymentPlans)
          .set({ status: 'COMPLETED', consecutiveFailureCount: 0, updatedAt: new Date() })
          .where(eq(clientPaymentPlans.id, plan.id));
        run.completed += 1;
      } else {
        await db
          .update(clientPaymentPlans)
          .set({
            nextRunDate: nextRunDate(day, plan.frequency),
            consecutiveFailureCount: 0,
            updatedAt: new Date(),
          })
          .where(eq(clientPaymentPlans.id, plan.id));
        run.charged += 1;
      }
    } catch (err) {
      run.failed += 1;
      log.error({ err, planId: plan.id }, 'payment-plan tick error');
    }
  }
  return run;
}
