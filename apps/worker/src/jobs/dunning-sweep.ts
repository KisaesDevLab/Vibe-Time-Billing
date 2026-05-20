// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Dunning sweep: walks invoices with status SENT/PARTIALLY_PAID/OVERDUE
// whose due_date is past today and emits the dunning steps that haven't
// already fired (recorded in a per-invoice ledger key on Redis or — in
// future — a dunning_history table).

import { and, eq, inArray, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { invoices } from '@vibe/db/schema';
import { stepsDueOn } from '@vibe/core/dunning';

import type { Logger } from 'pino';

export async function runDunningSweep(
  db: Database,
  log: Logger,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ scanned: number; stepsFired: number }> {
  const overdue = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      dueDate: invoices.dueDate,
      status: invoices.status,
    })
    .from(invoices)
    .where(
      and(
        inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
        lte(invoices.dueDate, today),
      ),
    )
    .limit(500);

  let stepsFired = 0;
  for (const inv of overdue) {
    const due = stepsDueOn({ invoiceDueDate: inv.dueDate, today });
    for (const step of due) {
      // In production this calls the email/sms dispatcher honoring
      // per-identity channel preferences. Skeleton just logs.
      log.info(
        { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, step: step.kind },
        'dunning step due',
      );
      stepsFired++;
      if (step.kind === 'AUTO_PAUSE') {
        // The engagement-pause path lives in apps/api; the worker would
        // POST to an internal endpoint here. Logging the intent for now.
        log.warn({ invoiceId: inv.id }, 'auto-pause threshold reached');
      }
    }
    // Flip status to OVERDUE if any dunning step has fired.
    if (due.length > 0 && inv.status === 'SENT') {
      await db.update(invoices).set({ status: 'OVERDUE' }).where(eq(invoices.id, inv.id));
    }
  }

  return { scanned: overdue.length, stepsFired };
}
