// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Balance query helpers. Balance = ledger credit sum − derived usage,
// where usage is SUM(time_entry.hours) over entries whose work code
// carries the bank's payroll category and status <> ARCHIVED. Usage is
// never mirrored into the ledger, so entry edits/archives self-correct.

import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { timeEntries, timeOffLedger, workCodes } from '@vibe/db/schema';
import { computeBalance } from '@vibe/core/payroll';
import type { TimeOffBank } from '@vibe/core/payroll';

export const BANKS: readonly TimeOffBank[] = ['PTO', 'SICK', 'COMP'];

/** work_code.payroll_category value that spends each bank. */
export const BANK_USAGE_CATEGORY: Record<TimeOffBank, string> = {
  PTO: 'PTO',
  SICK: 'SICK',
  COMP: 'COMP_USED',
};

export interface BankBalance {
  bank: TimeOffBank;
  accruedHours: number;
  usedHours: number;
  balanceHours: number;
}

/** Per-user, per-bank totals. Pass userIds to scope; [] returns nothing. */
export async function loadBalances(
  db: Database,
  firmId: string,
  userIds: string[],
): Promise<Map<string, BankBalance[]>> {
  const out = new Map<string, BankBalance[]>();
  if (userIds.length === 0) return out;
  for (const uid of userIds) {
    out.set(
      uid,
      BANKS.map((bank) => ({ bank, accruedHours: 0, usedHours: 0, balanceHours: 0 })),
    );
  }

  const credits = await db
    .select({
      appUserId: timeOffLedger.appUserId,
      bank: timeOffLedger.bank,
      total: sql<string>`COALESCE(SUM(${timeOffLedger.deltaHours}), 0)`.as('total'),
    })
    .from(timeOffLedger)
    .where(and(eq(timeOffLedger.firmId, firmId), inArray(timeOffLedger.appUserId, userIds)))
    .groupBy(timeOffLedger.appUserId, timeOffLedger.bank);

  const usage = await db
    .select({
      appUserId: timeEntries.appUserId,
      category: workCodes.payrollCategory,
      total: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`.as('total'),
    })
    .from(timeEntries)
    .innerJoin(workCodes, eq(workCodes.id, timeEntries.workCodeId))
    .where(
      and(
        inArray(timeEntries.appUserId, userIds),
        ne(timeEntries.status, 'ARCHIVED'),
        inArray(workCodes.payrollCategory, ['PTO', 'SICK', 'COMP_USED']),
      ),
    )
    .groupBy(timeEntries.appUserId, workCodes.payrollCategory);

  for (const c of credits) {
    const rows = out.get(c.appUserId);
    const row = rows?.find((r) => r.bank === c.bank);
    if (row) row.accruedHours = Number(c.total);
  }
  for (const u of usage) {
    const bank = (Object.keys(BANK_USAGE_CATEGORY) as TimeOffBank[]).find(
      (b) => BANK_USAGE_CATEGORY[b] === u.category,
    );
    if (!bank) continue;
    const row = out.get(u.appUserId)?.find((r) => r.bank === bank);
    if (row) row.usedHours = Number(u.total);
  }
  for (const rows of out.values()) {
    for (const r of rows) r.balanceHours = computeBalance(r.accruedHours, r.usedHours);
  }
  return out;
}

export async function loadUserBankBalance(
  db: Database,
  firmId: string,
  appUserId: string,
  bank: TimeOffBank,
): Promise<BankBalance> {
  const all = await loadBalances(db, firmId, [appUserId]);
  return (
    all.get(appUserId)?.find((r) => r.bank === bank) ?? {
      bank,
      accruedHours: 0,
      usedHours: 0,
      balanceHours: 0,
    }
  );
}
