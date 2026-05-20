// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Recurring-billing handler. For each ACTIVE plan whose next_run_date
// has arrived, in one transaction:
//   1. Create an APPROVED billing_batch for the period (subscription
//      plans don't need partner review — the fee is fixed).
//   2. Emit a single TIME_AGGREGATE invoice line for the plan amount.
//   3. Generate a DRAFT invoice numbered INV-YYYY-NNNNN, terms = client.
//   4. Advance the plan's next_run_date via @vibe/core/billing.nextRunDate.
//
// Auto-pay (when configured) is handled by a follow-up job — the worker
// keeps each tick small to bound transaction time.

import { and, eq, lte, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  billingBatches,
  clients,
  engagements,
  invoiceLineItems,
  invoices,
  recurringBillingPlans,
} from '@vibe/db/schema';
import { nextRunDate } from '@vibe/core/billing';
import { formatInvoiceNumber } from '@vibe/core/invoicing';

import type { Logger } from 'pino';

export interface RecurringBillingTickResult {
  batchesCreated: number;
  invoicesCreated: number;
  plansAdvanced: number;
  errors: number;
}

export async function runRecurringBillingTick(
  db: Database,
  log: Logger,
  today = new Date().toISOString().slice(0, 10),
): Promise<RecurringBillingTickResult> {
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
  let invoicesCreated = 0;
  let plansAdvanced = 0;
  let errors = 0;

  for (const plan of due) {
    const [eng] = await db
      .select()
      .from(engagements)
      .where(eq(engagements.id, plan.engagementId))
      .limit(1);
    if (!eng) {
      log.warn({ planId: plan.id }, 'plan engagement not found, skipping');
      continue;
    }
    const [client] = await db.select().from(clients).where(eq(clients.id, eng.clientId)).limit(1);
    if (!client) {
      log.warn({ planId: plan.id }, 'plan client not found, skipping');
      continue;
    }

    const periodStart = plan.nextRunDate;
    const periodEnd = today;
    const issueDate = today;
    const dueDate = new Date(Date.now() + client.termsDays * 86_400_000).toISOString().slice(0, 10);

    try {
      await db.transaction(async (tx) => {
        const [batch] = await tx
          .insert(billingBatches)
          .values({
            engagementId: plan.engagementId,
            periodStart,
            periodEnd,
            status: 'APPROVED',
            finalizedAt: new Date(),
          })
          .returning({ id: billingBatches.id });
        if (!batch) throw new Error('batch insert failed');

        // Per-firm sequence — read max numeric suffix and bump. The
        // unique index on (firm_id, invoice_number) catches collisions
        // if two ticks race.
        const [maxNum] = await tx
          .select({
            n: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM '[0-9]+$') AS INTEGER)), 0)`,
          })
          .from(invoices)
          .where(eq(invoices.firmId, client.firmId));
        const sequence = Number(maxNum?.n ?? 0) + 1;
        const invoiceNumber = formatInvoiceNumber({
          config: { prefix: 'INV', yearPart: 'FOUR_DIGIT' },
          sequence,
          issueDate,
        });

        const [inv] = await tx
          .insert(invoices)
          .values({
            firmId: client.firmId,
            clientId: client.id,
            primaryEngagementId: eng.id,
            invoiceNumber,
            issueDate,
            dueDate,
            subtotalCents: plan.amountCents,
            feeCents: 0,
            totalCents: plan.amountCents,
            status: 'DRAFT',
          })
          .returning({ id: invoices.id });
        if (!inv) throw new Error('invoice insert failed');

        await tx.insert(invoiceLineItems).values({
          invoiceId: inv.id,
          kind: 'RECURRING_FEE',
          description: `${eng.name} — ${periodStart} to ${periodEnd}`,
          amountCents: plan.amountCents,
          engagementId: eng.id,
          sourceRefType: 'recurring_plan',
          sourceRefId: plan.id,
          sortOrder: 0,
        });

        await tx
          .update(billingBatches)
          .set({ status: 'INVOICED' })
          .where(eq(billingBatches.id, batch.id));

        await tx
          .update(recurringBillingPlans)
          .set({ nextRunDate: nextRunDate(plan.nextRunDate, plan.frequency) })
          .where(eq(recurringBillingPlans.id, plan.id));

        batchesCreated++;
        invoicesCreated++;
        plansAdvanced++;
        log.info(
          { planId: plan.id, batchId: batch.id, invoiceId: inv.id, invoiceNumber },
          'recurring run complete',
        );
      });
    } catch (err) {
      errors++;
      log.error({ err, planId: plan.id }, 'recurring run failed');
    }
  }

  return { batchesCreated, invoicesCreated, plansAdvanced, errors };
}
