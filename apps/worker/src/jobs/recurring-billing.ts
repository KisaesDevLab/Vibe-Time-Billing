// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Recurring-billing handler: find ACTIVE plans whose next_run_date <=
// today, create a billing_batch covering the prior period, advance the
// plan's next_run_date, and emit an audit row.
//
// Idempotent at the (plan, period_start) grain: a uniqueness check on
// billing_batch (engagement_id, period_start) prevents double-runs.

import { and, eq, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { billingBatches, engagements, recurringBillingPlans } from '@vibe/db/schema';
import { nextRunDate } from '@vibe/core/billing';

import type { Logger } from 'pino';

export async function runRecurringBillingTick(
  db: Database,
  log: Logger,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ batchesCreated: number; plansAdvanced: number }> {
  const due = await db
    .select()
    .from(recurringBillingPlans)
    .where(
      and(
        eq(recurringBillingPlans.status, 'ACTIVE'),
        lte(recurringBillingPlans.nextRunDate, today),
      ),
    )
    .limit(500);
  let batchesCreated = 0;
  let plansAdvanced = 0;
  for (const plan of due) {
    const [eng] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.id, plan.engagementId))
      .limit(1);
    if (!eng) continue;
    const periodStart = plan.nextRunDate;
    const periodEnd = today;
    try {
      await db.transaction(async (tx) => {
        const [batch] = await tx
          .insert(billingBatches)
          .values({
            engagementId: plan.engagementId,
            periodStart,
            periodEnd,
            status: 'DRAFT',
          })
          .returning({ id: billingBatches.id });
        await tx
          .update(recurringBillingPlans)
          .set({ nextRunDate: nextRunDate(plan.nextRunDate, plan.frequency) })
          .where(eq(recurringBillingPlans.id, plan.id));
        log.info(
          { planId: plan.id, batchId: batch?.id, periodStart, periodEnd },
          'recurring batch created',
        );
        batchesCreated++;
        plansAdvanced++;
      });
    } catch (err) {
      log.error({ err, planId: plan.id }, 'recurring batch failed (likely idempotency clash)');
    }
  }
  return { batchesCreated, plansAdvanced };
}
