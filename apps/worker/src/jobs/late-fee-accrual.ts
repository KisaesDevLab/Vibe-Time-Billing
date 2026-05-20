// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Late-fee accrual job (Phase 13 #15). For each invoice whose status is
// OVERDUE/PARTIALLY_PAID and whose due_date has passed, compute the
// fee due using the firm-wide policy (env-configured for v1; per-firm
// columns are a v1.1 enhancement). Idempotent per day by checking for
// a same-day CUSTOM late-fee line item already attached to the invoice.

import { and, eq, inArray, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { invoiceLineItems, invoices } from '@vibe/db/schema';
import { computeLateFee } from '@vibe/core/invoicing';

import type { Logger } from 'pino';

export interface LateFeeAccrualDeps {
  /** Flat fee in cents, applied once when overdue. */
  flatCents?: number;
  /** Percent applied to invoice balance, monthly accrual. */
  pctMonthly?: number;
}

export async function runLateFeeAccrual(
  db: Database,
  log: Logger,
  today = new Date().toISOString().slice(0, 10),
  deps: LateFeeAccrualDeps = {},
): Promise<{ scanned: number; assessed: number; totalFeeCents: number }> {
  if (!deps.flatCents && !deps.pctMonthly) {
    return { scanned: 0, assessed: 0, totalFeeCents: 0 };
  }
  const overdue = await db
    .select({
      id: invoices.id,
      firmId: invoices.firmId,
      invoiceNumber: invoices.invoiceNumber,
      dueDate: invoices.dueDate,
      totalCents: invoices.totalCents,
      paidCents: invoices.paidCents,
    })
    .from(invoices)
    .where(
      and(inArray(invoices.status, ['OVERDUE', 'PARTIALLY_PAID']), lte(invoices.dueDate, today)),
    )
    .limit(500);

  let assessed = 0;
  let totalFeeCents = 0;
  for (const inv of overdue) {
    const balance = Number(inv.totalCents) - Number(inv.paidCents);
    if (balance <= 0) continue;
    // Idempotent per day — the description string includes today's
    // ISO date, so a same-day repeat run finds the marker.
    const todayMarker = `Late fee accrual (${today})`;
    const [already] = await db
      .select({ id: invoiceLineItems.id })
      .from(invoiceLineItems)
      .where(
        and(
          eq(invoiceLineItems.invoiceId, inv.id),
          eq(invoiceLineItems.sourceRefType, 'late_fee'),
          eq(invoiceLineItems.description, todayMarker),
        ),
      )
      .limit(1);
    if (already) continue;
    const daysOverdue = Math.max(
      0,
      Math.floor(
        (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${inv.dueDate}T00:00:00Z`)) / 86_400_000,
      ),
    );
    const fee = deps.pctMonthly
      ? computeLateFee({
          invoiceTotalCents: balance,
          policy: { kind: 'PERCENT', pct: deps.pctMonthly },
          daysOverdue,
        })
      : computeLateFee({
          invoiceTotalCents: balance,
          policy: { kind: 'FLAT', amountCents: deps.flatCents ?? 0 },
          daysOverdue,
        });
    if (fee <= 0) continue;
    await db.transaction(async (tx) => {
      await tx.insert(invoiceLineItems).values({
        invoiceId: inv.id,
        kind: 'CUSTOM',
        description: `Late fee accrual (${today})`,
        amountCents: fee,
        sourceRefType: 'late_fee',
        sortOrder: 999,
      });
      const newTotal = Number(inv.totalCents) + fee;
      await tx.update(invoices).set({ totalCents: newTotal }).where(eq(invoices.id, inv.id));
    });
    assessed++;
    totalFeeCents += fee;
    log.info({ invoiceId: inv.id, fee }, 'late fee accrued');
  }
  return { scanned: overdue.length, assessed, totalFeeCents };
}
