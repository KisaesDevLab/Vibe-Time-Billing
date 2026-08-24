// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Payroll-lock checks for the time-entry write paths. A LOCKED
// pay_period freezes every entry dated inside its range — create, edit,
// transfer, split, status change, archive — for all users and through
// every path (staff routes, timer save, bulk routes, MCP, REST v1).
// Deliberately separate from the billing concepts (locked_at /
// billing_batch_id), which stay untouched.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { payPeriods } from '@vibe/db/schema';

export interface LockedRange {
  startDate: string;
  endDate: string;
}

/** The firm's LOCKED period ranges (few rows; fetch once per request). */
export async function loadPayrollLockedRanges(
  db: Database,
  firmId: string,
): Promise<LockedRange[]> {
  return db
    .select({ startDate: payPeriods.startDate, endDate: payPeriods.endDate })
    .from(payPeriods)
    .where(and(eq(payPeriods.firmId, firmId), eq(payPeriods.status, 'LOCKED')));
}

export function dateIsPayrollLocked(ranges: readonly LockedRange[], date: string): boolean {
  return ranges.some((r) => date >= r.startDate && date <= r.endDate);
}

export async function isPayrollLocked(
  db: Database,
  firmId: string,
  entryDate: string,
): Promise<boolean> {
  return dateIsPayrollLocked(await loadPayrollLockedRanges(db, firmId), entryDate);
}

/** First date in the list inside a LOCKED period, or null. */
export async function firstPayrollLockedDate(
  db: Database,
  firmId: string,
  dates: readonly string[],
): Promise<string | null> {
  if (dates.length === 0) return null;
  const ranges = await loadPayrollLockedRanges(db, firmId);
  if (ranges.length === 0) return null;
  return dates.find((d) => dateIsPayrollLocked(ranges, d)) ?? null;
}
