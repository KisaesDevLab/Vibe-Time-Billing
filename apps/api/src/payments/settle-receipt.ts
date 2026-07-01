// SPDX-License-Identifier: Elastic-2.0
//
// Settlement of a PENDING charge receipt: insert one payment per allocation
// under an invoice row-lock, recompute paid_cents, flip the receipt SUCCEEDED,
// and (idempotently) enqueue the terminal receipt auto-print. Extracted from
// webhooks/stripe.ts so the off-session charge service — imported by the worker
// — can settle synchronously without pulling the Express-typed webhook module
// (and its staff-authed transitive imports) into the worker's tsc program.

import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { invoices, payments, paymentReceipts, printLog, terminalReaders } from '@vibe/db/schema';

import type { PrintQueue } from '../print-gateway/queue';
import { emitAudit } from '../auth/audit';
import { logger } from '../logger';
import { recomputeInvoicePaid } from './recompute';

// Exported so the off-session charge service can settle synchronously when a
// card charge returns 'succeeded' immediately (the webhook is the backstop;
// this is idempotent — a re-run finds the receipt already SUCCEEDED → no-op).
export async function materializeReceiptIfPending(
  db: Database,
  intentId: string,
  printQueue?: PrintQueue,
): Promise<boolean> {
  const [receipt] = await db
    .select()
    .from(paymentReceipts)
    .where(eq(paymentReceipts.providerChargeId, intentId))
    .limit(1);
  if (!receipt) return false;
  if (receipt.status === 'SUCCEEDED') {
    // Re-delivery. The receipt was already materialized, but a crash between
    // the commit and the enqueue on the original delivery could have left the
    // auto-print un-enqueued — so we (idempotently) ensure it here too. The
    // deterministic queue jobId + gateway idempotency key prevent any double
    // physical print.
    await enqueueTerminalReceiptPrint(db, receipt, printQueue);
    return true;
  }
  if (receipt.status !== 'PENDING') return true;
  const allocations = (receipt.allocationsPending ?? []) as {
    invoiceId: string;
    amountCents: number;
  }[];
  if (allocations.length === 0) {
    await db
      .update(paymentReceipts)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(eq(paymentReceipts.id, receipt.id));
    logger.warn({ receiptId: receipt.id }, 'pending receipt had no allocations');
    return true;
  }

  await db.transaction(async (tx) => {
    // Lock allocation invoices in firm scope, then re-validate balances.
    const locked = await tx
      .select({
        id: invoices.id,
        totalCents: invoices.totalCents,
        paidCents: invoices.paidCents,
      })
      .from(invoices)
      .where(
        and(
          inArray(
            invoices.id,
            allocations.map((a) => a.invoiceId),
          ),
          eq(invoices.firmId, receipt.firmId),
        ),
      )
      .for('update');
    const lockedById = new Map(locked.map((i) => [i.id, i]));
    const receivedAt = new Date();
    for (const a of allocations) {
      const inv = lockedById.get(a.invoiceId);
      if (!inv) {
        // Invoice disappeared (voided?) between intent and confirmation —
        // skip this row; the receipt total may not match the sum applied,
        // which the reconciliation report will surface.
        continue;
      }
      const open = Number(inv.totalCents) - Number(inv.paidCents);
      // If someone else already paid the invoice down (e.g., portal pay
      // between intent and webhook), apply only what fits. Excess gets
      // dropped — better than violating the invoice CHECK constraint.
      const apply = Math.min(a.amountCents, open);
      if (apply <= 0) continue;
      await tx.insert(payments).values({
        invoiceId: inv.id,
        amountCents: apply,
        feeCents: 0,
        provider: 'STRIPE',
        providerChargeId: intentId,
        status: 'SUCCEEDED',
        receivedAt,
        receiptId: receipt.id,
      });
      await recomputeInvoicePaid(tx, inv.id);
    }
    await tx
      .update(paymentReceipts)
      .set({
        status: 'SUCCEEDED',
        allocationsPending: null,
        updatedAt: new Date(),
      })
      .where(eq(paymentReceipts.id, receipt.id));
  });

  // 0186 — auto-print the receipt to the terminal's configured printer.
  // Idempotent (deterministic jobId + gateway idempotency key), so it is also
  // safe to re-run on webhook re-delivery (see the SUCCEEDED branch above).
  await enqueueTerminalReceiptPrint(db, receipt, printQueue);

  await emitAudit(db, {
    action: 'PAYMENT',
    entityType: 'payment_receipt',
    entityId: receipt.id,
    after: {
      kind: 'receive_materialized',
      providerChargeId: intentId,
      allocationCount: allocations.length,
    },
  }).catch((err: unknown) =>
    logger.error({ err, receiptId: receipt.id }, 'audit emit failed (receive_materialized)'),
  );

  return true;
}

/** 0186 — enqueue the terminal receipt auto-print for a SUCCEEDED receipt.
 *  Idempotent: the queue uses a deterministic jobId and the worker sends with
 *  a `termreceipt:` gateway idempotency key, so calling this on both the fresh
 *  transition and any webhook re-delivery prints at most once. */
async function enqueueTerminalReceiptPrint(
  db: Database,
  receipt: { id: string; firmId: string; terminalReaderId: string | null },
  printQueue?: PrintQueue,
): Promise<void> {
  if (!printQueue || !receipt.terminalReaderId) return;
  const [reader] = await db
    .select({ printerId: terminalReaders.printerId, autoPrint: terminalReaders.autoPrintReceipt })
    .from(terminalReaders)
    .where(eq(terminalReaders.id, receipt.terminalReaderId))
    .limit(1);
  if (!reader?.autoPrint) return;
  if (reader.printerId != null) {
    await printQueue
      .terminalReceipt({ receiptId: receipt.id, printerId: reader.printerId })
      .catch((err: unknown) =>
        logger.error({ err, receiptId: receipt.id }, 'terminal receipt enqueue failed'),
      );
  } else {
    // Auto-print on but no printer assigned → skip + log (don't print to the
    // wrong location).
    await db
      .insert(printLog)
      .values({
        firmId: receipt.firmId,
        appUserId: null,
        printableType: 'payment_receipt',
        printableId: receipt.id,
        printerId: 0,
        status: 'FAILED',
        error: 'no_printer_assigned',
      })
      .catch(() => undefined);
  }
}
