// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Invoice paid-amount recompute. Extracted from payments/routes.ts so the
// webhook + off-session charge path (imported by the worker) does not drag the
// Express-typed routes module into the worker's tsc program.

import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { invoices, payments } from '@vibe/db/schema';

/**
 * Idempotent recompute of invoice.paid_cents from successful payments.
 * Run inside a transaction that already holds the invoice row lock.
 *
 * Also updates status (PAID / PARTIALLY_PAID) and clears paidAt when the
 * row goes from PAID back to PARTIALLY_PAID (e.g., after a refund).
 */
export async function recomputeInvoicePaid(tx: Database, invoiceId: string): Promise<void> {
  await recomputeInvoicePaidReturnsFullyPaid(tx, invoiceId);
}

/**
 * Same as recomputeInvoicePaid but reports whether the invoice
 * transitioned to (or remains) PAID after recompute. Used by /receive
 * to decide which invoices to fire the escrow-promote hook on.
 */
export async function recomputeInvoicePaidReturnsFullyPaid(
  tx: Database,
  invoiceId: string,
): Promise<boolean> {
  // Serialize concurrent recomputes on the same invoice: take the invoice
  // ROW LOCK BEFORE reading the payment sum, so a void/edit/reapply that
  // races a webhook settlement can't compute paid_cents from a stale
  // snapshot and clobber the other's write (lost update). Re-entrant when
  // the caller already holds the lock (e.g. the webhook succeeded path).
  await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for('update')
    .limit(1);
  // Net-of-refunds paid amount: a payment contributes (amount − refunded).
  // SUCCEEDED with no refund → full amount; PARTIALLY_REFUNDED → the
  // un-refunded remainder; REFUNDED → 0 (amount − amount). This is what
  // reopens an invoice when a refund/ACH-return/dispute posts.
  const [agg] = await tx
    .select({
      paidCents: sql<number>`COALESCE(SUM(${payments.amountCents} - COALESCE(${payments.refundedAmountCents}, 0)), 0)::bigint`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.invoiceId, invoiceId),
        sql`${payments.status} IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')`,
        sql`${payments.voidedAt} IS NULL`,
      ),
    );
  const [inv] = await tx
    .select({
      total: invoices.totalCents,
      currentStatus: invoices.status,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!inv) return false;
  const paidCents = Number(agg?.paidCents ?? 0);
  const total = Number(inv.total);
  let nextStatus: typeof inv.currentStatus;
  if (paidCents >= total) {
    nextStatus = 'PAID';
  } else if (paidCents > 0) {
    nextStatus = 'PARTIALLY_PAID';
  } else if (inv.currentStatus === 'PAID' || inv.currentStatus === 'PARTIALLY_PAID') {
    // Paid amount fell back to zero (e.g. a payment was voided) — return the
    // invoice to the unpaid list as OVERDUE (if past due) or SENT. DRAFT /
    // VOIDED invoices are left untouched.
    const overdue = inv.dueDate != null && inv.dueDate < new Date().toISOString().slice(0, 10);
    nextStatus = overdue ? 'OVERDUE' : 'SENT';
  } else {
    nextStatus = inv.currentStatus;
  }
  await tx
    .update(invoices)
    .set({
      paidCents,
      status: nextStatus,
      paidAt: nextStatus === 'PAID' ? new Date() : null,
    })
    .where(eq(invoices.id, invoiceId));
  return nextStatus === 'PAID';
}
