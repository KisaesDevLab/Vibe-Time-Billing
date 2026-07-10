// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Helpers for the recurring installment plan: load a client's open invoices
// oldest-first and split a charge amount across them.

import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { invoices } from '@vibe/db/schema';

export interface OpenInvoice {
  id: string;
  balanceCents: number;
}

/** Open invoices for a client (SENT / PARTIALLY_PAID / OVERDUE, balance > 0),
 *  oldest-first by due date then issue date. */
export async function loadOpenInvoicesOldestFirst(
  db: Database,
  firmId: string,
  clientId: string,
): Promise<OpenInvoice[]> {
  const rows = await db
    .select({
      id: invoices.id,
      totalCents: invoices.totalCents,
      paidCents: invoices.paidCents,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.firmId, firmId),
        eq(invoices.clientId, clientId),
        inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
      ),
    )
    .orderBy(asc(invoices.dueDate), asc(invoices.issueDate));
  return rows
    .map((r) => ({ id: r.id, balanceCents: Number(r.totalCents) - Number(r.paidCents) }))
    .filter((r) => r.balanceCents > 0);
}

/** Total open balance across the given invoices. */
export function outstandingCents(open: OpenInvoice[]): number {
  return open.reduce((sum, i) => sum + i.balanceCents, 0);
}

export interface Allocation {
  invoiceId: string;
  amountCents: number;
}

/** Split `amountCents` across open invoices oldest-first (each capped at its
 *  balance). Assumes `amountCents <= outstandingCents(open)` so it allocates
 *  in full; any remainder (shouldn't happen) is simply not allocated. */
export function buildAllocations(open: OpenInvoice[], amountCents: number): Allocation[] {
  const out: Allocation[] = [];
  let remaining = amountCents;
  for (const inv of open) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, inv.balanceCents);
    if (take > 0) {
      out.push({ invoiceId: inv.id, amountCents: take });
      remaining -= take;
    }
  }
  return out;
}
