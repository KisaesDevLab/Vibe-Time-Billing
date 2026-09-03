// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Year-end carryover forfeit (0226). Runs Jan 1: for every active
// assignment whose policy sets carryover_cap_hours, the balance carried
// past the cap is forfeited with a negative CARRYOVER_FORFEIT ledger row.
// Idempotent via period_key 'CY:<closed year>'.

import { and, eq, isNull, like, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  accrualPolicies,
  accrualPolicyAssignments,
  appUsers,
  timeOffLedger,
} from '@vibe/db/schema';
import { computeCarryoverForfeit, round2, yearOf } from '@vibe/core/payroll';

import type { Logger } from 'pino';

import { bankBalance } from './payroll-accrual';

export async function runPayrollCarryover(
  db: Database,
  log: Logger,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<{ scanned: number; forfeits: number }> {
  const closedYear = yearOf(today) - 1;
  const assignments = await db
    .select({
      firmId: accrualPolicyAssignments.firmId,
      appUserId: accrualPolicyAssignments.appUserId,
      policy: accrualPolicies,
    })
    .from(accrualPolicyAssignments)
    .innerJoin(accrualPolicies, eq(accrualPolicies.id, accrualPolicyAssignments.policyId))
    .innerJoin(appUsers, eq(appUsers.id, accrualPolicyAssignments.appUserId))
    .where(
      and(
        isNull(accrualPolicyAssignments.endDate),
        eq(accrualPolicies.status, 'ACTIVE'),
        eq(appUsers.status, 'ACTIVE'),
      ),
    );

  let forfeits = 0;
  for (const a of assignments) {
    if (a.policy.carryoverCapHours == null) continue;
    // Balance AS OF Dec 31 of the closed year — never the live balance,
    // which on Jan 1 already contains the new year's annual grant (the
    // daily accrual job runs before this one) and would wrongly forfeit
    // part of the fresh grant.
    const balance = await bankBalance(
      db,
      a.firmId,
      a.appUserId,
      a.policy.bank,
      `${closedYear}-12-31`,
    );
    const forfeit = computeCarryoverForfeit(balance, Number(a.policy.carryoverCapHours));

    // What we have already forfeited for this year. The ledger is
    // append-only, so a correction is another row rather than an edit.
    // Without this the first run's number was frozen forever: December
    // hours entered afterwards (the late-entry window runs 14 days, and
    // the job fires while Dec 31 is still in progress in US timezones)
    // left the employee permanently over-forfeited.
    const [priorRow] = await db
      .select({ total: sql<string>`COALESCE(SUM(${timeOffLedger.deltaHours}), 0)` })
      .from(timeOffLedger)
      .where(
        and(
          eq(timeOffLedger.firmId, a.firmId),
          eq(timeOffLedger.appUserId, a.appUserId),
          eq(timeOffLedger.bank, a.policy.bank),
          eq(timeOffLedger.reason, 'CARRYOVER_FORFEIT'),
          like(timeOffLedger.periodKey, `CY:${closedYear}%`),
        ),
      );
    const already = Number(priorRow?.total ?? 0);
    const delta = round2(forfeit - already);
    if (delta === 0) continue;

    const isCorrection = already !== 0;
    const inserted = await db
      .insert(timeOffLedger)
      .values({
        firmId: a.firmId,
        appUserId: a.appUserId,
        bank: a.policy.bank,
        deltaHours: delta.toString(),
        reason: 'CARRYOVER_FORFEIT',
        policyId: a.policy.id,
        // One correction per day, so re-running converges instead of
        // stacking duplicates.
        periodKey: isCorrection ? `CY:${closedYear}:TRUEUP:${today}` : `CY:${closedYear}`,
        note: isCorrection
          ? `Carryover true-up for ${closedYear} after late entries (cap ${a.policy.carryoverCapHours}h)`
          : `Year-end carryover cap ${a.policy.carryoverCapHours}h (${a.policy.name})`,
      })
      .onConflictDoNothing()
      .returning({ id: timeOffLedger.id });
    if (inserted.length > 0) forfeits++;
  }

  log.info({ scanned: assignments.length, forfeits, closedYear }, 'payroll carryover done');
  return { scanned: assignments.length, forfeits };
}
