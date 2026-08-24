// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Payroll-lock check for the time-entry write paths. A LOCKED pay_period
// freezes every entry dated inside its range (create, edit, archive) for
// all users — deliberately separate from the billing concepts
// (locked_at / billing_batch_id), which stay untouched.

import { and, eq, gte, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { payPeriods } from '@vibe/db/schema';

export async function isPayrollLocked(
  db: Database,
  firmId: string,
  entryDate: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: payPeriods.id })
    .from(payPeriods)
    .where(
      and(
        eq(payPeriods.firmId, firmId),
        eq(payPeriods.status, 'LOCKED'),
        lte(payPeriods.startDate, entryDate),
        gte(payPeriods.endDate, entryDate),
      ),
    )
    .limit(1);
  return Boolean(row);
}
