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
  appUsers,
  billingBatchEngagements,
  billingBatchEntries,
  billingBatches,
  clients,
  engagements,
  invoiceLineItems,
  invoices,
  payments,
  recurringBillingPlans,
  timeEntries,
} from '@vibe/db/schema';
import { gte, isNull, lte as drzLte } from 'drizzle-orm';
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
  /** Optional email dispatcher — when present, partners get notified on auto-pause (Phase 10 #32). */
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
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
    // Phase 10 #35 — explicit idempotency key. Deterministic per
    // (plan, period_start). Index on idempotency_key makes the duplicate
    // insert error fail fast, which we catch and skip below.
    const idempotencyKey = `recurring:${plan.id}:${periodStart}`;
    const [existingBatch] = await db
      .select({ id: billingBatches.id })
      .from(billingBatches)
      .where(eq(billingBatches.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existingBatch) {
      log.info(
        { planId: plan.id, periodStart, batchId: existingBatch.id },
        'recurring tick skipped — idempotency key already present',
      );
      // Advance nextRunDate anyway so this plan doesn't re-trigger forever.
      await db
        .update(recurringBillingPlans)
        .set({ nextRunDate: nextRunDate(plan.nextRunDate, plan.frequency) })
        .where(eq(recurringBillingPlans.id, plan.id));
      continue;
    }
    // Phase 10 #5 — per-period WIP rollup. HOURLY / HOURLY_NTE engagements
    // bill by actual time worked, so the recurring tick rolls up unbilled
    // entries in the period. RECURRING_SUBSCRIPTION (and other fee
    // structures) keep the flat-amount line.
    const isTimeBased = eng.feeStructure === 'HOURLY' || eng.feeStructure === 'HOURLY_NTE';
    let rolledUpEntries: { id: string; amountCents: number }[] = [];
    let rolledUpAmount = 0;
    if (isTimeBased) {
      const rows = await db
        .select({
          id: timeEntries.id,
          amountCents: timeEntries.standardAmountCents,
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.engagementId, eng.id),
            isNull(timeEntries.billingBatchId),
            gte(timeEntries.entryDate, periodStart),
            drzLte(timeEntries.entryDate, periodEnd),
          ),
        );
      rolledUpEntries = rows.map((r) => ({ id: r.id, amountCents: Number(r.amountCents) }));
      rolledUpAmount = rolledUpEntries.reduce((s, r) => s + r.amountCents, 0);
      // If there's no WIP to bill on a time-based plan, skip the tick
      // entirely but still advance nextRunDate so the schedule moves on.
      if (rolledUpAmount === 0) {
        log.info(
          { planId: plan.id, periodStart, periodEnd },
          'recurring tick: time-based plan with zero WIP, skipping invoice',
        );
        await db
          .update(recurringBillingPlans)
          .set({ nextRunDate: nextRunDate(plan.nextRunDate, plan.frequency) })
          .where(eq(recurringBillingPlans.id, plan.id));
        continue;
      }
    }
    const invoiceAmount = isTimeBased ? rolledUpAmount : plan.amountCents;
    try {
      await db.transaction(async (tx) => {
        const [batch] = await tx
          .insert(billingBatches)
          .values({
            engagementId: plan.engagementId,
            periodStart,
            periodEnd,
            status: 'APPROVED',
            idempotencyKey,
            finalizedAt: new Date(),
          })
          .returning({ id: billingBatches.id });
        if (!batch) throw new Error('batch insert failed');

        // 0086 — record the single-engagement set in the join table so
        // GET handlers can read engagements uniformly via the join.
        await tx.insert(billingBatchEngagements).values({
          billingBatchId: batch.id,
          engagementId: plan.engagementId,
          ordinal: 0,
        });

        // Attach the rolled-up entries to the batch so they're flagged
        // as billed and won't be picked up by the next tick.
        if (rolledUpEntries.length > 0) {
          await tx
            .update(timeEntries)
            .set({ billingBatchId: batch.id })
            .where(
              sql`${timeEntries.id} = ANY(ARRAY[${sql.join(
                rolledUpEntries.map((e) => sql`${e.id}::uuid`),
                sql`, `,
              )}])`,
            );
          await tx.insert(billingBatchEntries).values(
            rolledUpEntries.map((e) => ({
              billingBatchId: batch.id,
              timeEntryId: e.id,
              action: 'INCLUDE' as const,
            })),
          );
        }

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
            subtotalCents: invoiceAmount,
            feeCents: 0,
            totalCents: invoiceAmount,
            status: 'DRAFT',
          })
          .returning({ id: invoices.id });
        if (!inv) throw new Error('invoice insert failed');

        await tx.insert(invoiceLineItems).values({
          invoiceId: inv.id,
          kind: isTimeBased ? 'TIME_AGGREGATE' : 'RECURRING_FEE',
          description: isTimeBased
            ? `${eng.name} — time billed ${periodStart} to ${periodEnd} (${rolledUpEntries.length} entries)`
            : `${eng.name} — ${periodStart} to ${periodEnd}`,
          amountCents: invoiceAmount,
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
    //
    // CP9 — resolve the autopay method with engagement-level precedence
    // (Build Plan §2.2):
    //   1. engagement.autopay_method_id (when set AND not paused) wins
    //   2. Else fall back to plan.autoPayPaymentMethodId
    // Pause window: when autopay_paused_until is in the future, autopay
    // is skipped entirely for this engagement.
    let resolvedAutopayMethodId: string | null = null;
    const paused = eng.autopayPausedUntil != null && String(eng.autopayPausedUntil) >= today;
    if (!paused && eng.autopayMethodId) {
      resolvedAutopayMethodId = eng.autopayMethodId;
    } else if (!paused && plan.autoPayFlag && plan.autoPayPaymentMethodId) {
      resolvedAutopayMethodId = plan.autoPayPaymentMethodId;
    }
    if (resolvedAutopayMethodId && deps.chargeInvoice && createdInvoiceId) {
      try {
        const result = await deps.chargeInvoice({
          invoiceId: createdInvoiceId,
          paymentMethodProviderId: resolvedAutopayMethodId,
          amountCents: invoiceAmount,
          metadata: {
            invoice_id: createdInvoiceId,
            invoice_number: createdInvoiceNumber ?? '',
            firm_id: client.firmId,
            client_id: client.id,
            autopay: 'true',
            autopay_source: eng.autopayMethodId ? 'engagement' : 'plan',
          },
        });
        if (result.ok) {
          await db.insert(payments).values({
            invoiceId: createdInvoiceId,
            amountCents: invoiceAmount,
            feeCents: 0,
            paymentMethodId: resolvedAutopayMethodId,
            provider: 'STRIPE',
            providerChargeId: result.providerChargeId ?? null,
            status: 'SUCCEEDED',
            receivedAt: new Date(),
          });
          await db
            .update(invoices)
            .set({
              status: 'PAID',
              paidCents: invoiceAmount,
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
          // Phase 10 #28 — insert a FAILED payment row with nextRetryAt
          // set to +3 days. The payment-retry worker picks this up.
          await db.insert(payments).values({
            invoiceId: createdInvoiceId,
            amountCents: invoiceAmount,
            feeCents: 0,
            paymentMethodId: plan.autoPayPaymentMethodId,
            provider: 'STRIPE',
            providerChargeId: null,
            status: 'FAILED',
            receivedAt: new Date(),
            retryCount: 0,
            nextRetryAt: new Date(Date.now() + 3 * 86_400_000),
          });
          await handleAutopayFailure(db, log, plan, deps);
          log.warn({ invoiceId: createdInvoiceId, err: result.errorMessage }, 'autopay failed');
        }
      } catch (err) {
        autopayFailed++;
        if (createdInvoiceId) {
          await db.insert(payments).values({
            invoiceId: createdInvoiceId,
            amountCents: invoiceAmount,
            feeCents: 0,
            paymentMethodId: plan.autoPayPaymentMethodId,
            provider: 'STRIPE',
            providerChargeId: null,
            status: 'FAILED',
            receivedAt: new Date(),
            retryCount: 0,
            nextRetryAt: new Date(Date.now() + 3 * 86_400_000),
          });
        }
        await handleAutopayFailure(db, log, plan, deps);
        log.error({ err, invoiceId: createdInvoiceId }, 'autopay errored');
      }
    }
  }

  return { batchesCreated, invoicesCreated, plansAdvanced, autopayCharged, autopayFailed, errors };
}

async function handleAutopayFailure(
  db: Database,
  log: Logger,
  plan: {
    id: string;
    engagementId: string;
    consecutiveFailureCount: number;
    autopayPauseThreshold: number;
  },
  deps: RecurringBillingDeps = {},
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
    // Phase 10 #32 — partner notification on auto-pause.
    if (deps.sendEmail) {
      try {
        const [eng] = await db
          .select({
            engagementName: engagements.name,
            clientName: clients.name,
            partnerEmail: appUsers.email,
            partnerName: appUsers.fullName,
          })
          .from(engagements)
          .innerJoin(clients, eq(clients.id, engagements.clientId))
          .innerJoin(appUsers, eq(appUsers.id, engagements.partnerId))
          .where(eq(engagements.id, plan.engagementId))
          .limit(1);
        if (eng?.partnerEmail) {
          await deps.sendEmail({
            to: eng.partnerEmail,
            subject: `Auto-paused: ${eng.clientName} · ${eng.engagementName}`,
            body: [
              `Hi ${eng.partnerName ?? 'there'},`,
              ``,
              `The recurring plan on ${eng.engagementName} (${eng.clientName}) was auto-paused`,
              `after ${threshold} consecutive autopay failures. No more invoices will be`,
              `generated until the payment method is updated and the plan is resumed.`,
              ``,
              `Recommendation: reach out to the client before the next billing cycle.`,
            ].join('\n'),
          });
        }
      } catch (err) {
        log.warn({ err, planId: plan.id }, 'auto-pause notify dispatch failed');
      }
    }
  } else {
    await db
      .update(recurringBillingPlans)
      .set({ consecutiveFailureCount: next })
      .where(eq(recurringBillingPlans.id, plan.id));
  }
}
