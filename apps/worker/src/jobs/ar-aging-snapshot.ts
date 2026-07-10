// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Nightly per-client AR aging snapshot. Writes one row per
// (firm, client, as_of_date) into ar_aging_snapshot. Bucketize uses the
// same domain helper as the live endpoint so reports never disagree.

import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, firms, invoices } from '@vibe/db/schema';
import { bucketize, type AgingBucket } from '@vibe/core/billing';

import type { Logger } from 'pino';

export async function runArAgingSnapshot(
  db: Database,
  log: Logger,
  today = new Date().toISOString().slice(0, 10),
): Promise<{ firmsScanned: number; snapshotsWritten: number }> {
  const allFirms = await db.select({ id: firms.id }).from(firms);
  let snapshotsWritten = 0;
  for (const firm of allFirms) {
    const firmClients = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.firmId, firm.id));
    if (firmClients.length === 0) continue;
    const open = await db
      .select({
        clientId: invoices.clientId,
        dueDate: invoices.dueDate,
        totalCents: invoices.totalCents,
        paidCents: invoices.paidCents,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.firmId, firm.id),
          inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
          ne(invoices.status, 'VOIDED'),
        ),
      );
    const byClient = new Map<string, { entryDate: string; amountCents: number }[]>();
    for (const inv of open) {
      const balance = Number(inv.totalCents) - Number(inv.paidCents);
      if (balance <= 0) continue;
      const arr = byClient.get(inv.clientId) ?? [];
      arr.push({ entryDate: inv.dueDate, amountCents: balance });
      byClient.set(inv.clientId, arr);
    }
    for (const [clientId, rows] of byClient) {
      const b: Record<AgingBucket, number> = bucketize(rows, today);
      const total = b['0-30'] + b['31-60'] + b['61-90'] + b['90+'];
      await db.execute(sql`
        INSERT INTO ar_aging_snapshot (
          firm_id, client_id, as_of_date,
          bucket_0_30_cents, bucket_31_60_cents, bucket_61_90_cents, bucket_90_plus_cents,
          total_cents
        ) VALUES (
          ${firm.id}, ${clientId}, ${today},
          ${b['0-30']}, ${b['31-60']}, ${b['61-90']}, ${b['90+']},
          ${total}
        )
        ON CONFLICT (firm_id, client_id, as_of_date) DO UPDATE
          SET bucket_0_30_cents    = EXCLUDED.bucket_0_30_cents,
              bucket_31_60_cents   = EXCLUDED.bucket_31_60_cents,
              bucket_61_90_cents   = EXCLUDED.bucket_61_90_cents,
              bucket_90_plus_cents = EXCLUDED.bucket_90_plus_cents,
              total_cents          = EXCLUDED.total_cents
      `);
      snapshotsWritten++;
    }
  }
  log.info({ firmsScanned: allFirms.length, snapshotsWritten }, 'ar-aging snapshot complete');
  return { firmsScanned: allFirms.length, snapshotsWritten };
}
