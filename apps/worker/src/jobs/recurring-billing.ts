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
  payments,
  recurringBillingPlans,
} from '@vibe/db/schema';
import { nextRunDate } from '@vibe/core/billing';
import { formatInvoiceNumber } from '@vibe/core/invoicing';

import type { Logger } from 'pino';

export interface RecurringBillingTickResult {
  batchesCreated: number;
  invoicesCreated: number;
  plansAdvanced: number;
  autopayCharged: number;
  autopayFailed: number;
  errors: number;
}

export interface RecurringBillingDeps {
  /** Optional charge function — if absent, autopay is skipped. */
  chargeInvoice?: (args: {
    invoiceId: string;
    paymentMethodProviderId: string;
    amountCents: number;
    metadata: Record<string, string>;
  }) => Promise<{ ok: boolean; providerChargeId?: string; errorMessage?: string }>;
}

export async function runRecurringBillingTick(
  db: Database,
  log: Logger,
  today = new Date().toISOString().slice(0, 10),
  deps: RecurringBillingDeps = {},
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
  let autopayCharged = 0;
  let autopayFailed = 0;
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

    let createdInvoiceId: string | null = null;
    let createdInvoiceNumber: string | null = null;
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
        createdInvoiceId = inv.id;
        createdInvoiceNumber = invoiceNumber;
        log.info(
          { planId: plan.id, batchId: batch.id, invoiceId: inv.id, invoiceNumber },
          'recurring run complete',
        );
      });
    } catch (err) {
      errors++;
      log.error({ err, planId: plan.id }, 'recurring run failed');
      continue;
    }

    // Autopay — runs outside the create transaction so a payment failure
    // doesn't roll back the invoice. The portal still surfaces the unpaid
    // invoice; the dunning-sweep job picks it up after due_date.
    if (plan.autoPayFlag && plan.autoPayPaymentMethodId && deps.chargeInvoice && createdInvoiceId) {
      try {
        const result = await deps.chargeInvoice({
          invoiceId: createdInvoiceId,
          paymentMethodProviderId: plan.autoPayPaymentMethodId,
          amountCents: plan.amountCents,
          metadata: {
            invoice_id: createdInvoiceId,
            invoice_number: createdInvoiceNumber ?? '',
            firm_id: client.firmId,
            client_id: client.id,
            autopay: 'true',
          },
        });
        if (result.ok) {
          await db.insert(payments).values({
            invoiceId: createdInvoiceId,
            amountCents: plan.amountCents,
            feeCents: 0,
            paymentMethodId: plan.autoPayPaymentMethodId,
            provider: 'STRIPE',
            providerChargeId: result.providerChargeId ?? null,
            status: 'SUCCEEDED',
            receivedAt: new Date(),
          });
          await db
            .update(invoices)
            .set({
              status: 'PAID',
              paidCents: plan.amountCents,
              paidAt: new Date(),
              sentAt: new Date(),
            })
            .where(eq(invoices.id, createdInvoiceId));
          autopayCharged++;
          // Success resets the consecutive-failure counter.
          await db
            .update(recurringBillingPlans)
            .set({ consecutiveFailureCount: 0 })
            .where(eq(recurringBillingPlans.id, plan.id));
          log.info(
            { invoiceId: createdInvoiceId, providerChargeId: result.providerChargeId },
            'autopay charged',
          );
        } else {
          autopayFailed++;
          await handleAutopayFailure(db, log, plan);
          log.warn({ invoiceId: createdInvoiceId, err: result.errorMessage }, 'autopay failed');
        }
      } catch (err) {
        autopayFailed++;
        await handleAutopayFailure(db, log, plan);
        log.error({ err, invoiceId: createdInvoiceId }, 'autopay errored');
      }
    }
  }

  return { batchesCreated, invoicesCreated, plansAdvanced, autopayCharged, autopayFailed, errors };
}

async function handleAutopayFailure(
  db: Database,
  log: Logger,
  plan: { id: string; consecutiveFailureCount: number; autopayPauseThreshold: number },
): Promise<void> {
  const next = (plan.consecutiveFailureCount ?? 0) + 1;
  const threshold = plan.autopayPauseThreshold ?? 3;
  if (next >= threshold) {
    await db
      .update(recurringBillingPlans)
      .set({
        consecutiveFailureCount: next,
        status: 'PAUSED',
        pausedAt: new Date(),
        pausedReason: 'autopay_threshold',
      })
      .where(eq(recurringBillingPlans.id, plan.id));
    log.warn({ planId: plan.id, failures: next, threshold }, 'recurring plan auto-paused');
  } else {
    await db
      .update(recurringBillingPlans)
      .set({ consecutiveFailureCount: next })
      .where(eq(recurringBillingPlans.id, plan.id));
  }
}
