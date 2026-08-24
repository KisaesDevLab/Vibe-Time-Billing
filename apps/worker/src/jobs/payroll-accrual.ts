// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Payroll accrual sweep (0226). Nightly: materializes pay_period rows
// ahead of time, then writes PTO/Sick/Comp accrual ledger rows for every
// completed period per active full-time assignment (FIXED_PER_PERIOD /
// PER_HOURS_WORKED) and annual grants due this year (ANNUAL_GRANT).
// Idempotent throughout: every job-written ledger row carries a
// period_key under a partial unique index, inserted with
// ON CONFLICT DO NOTHING — re-runs are no-ops.

import { and, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  accrualPolicies,
  accrualPolicyAssignments,
  accrualPolicyTiers,
  appUsers,
  firmSettings,
  payPeriods,
  timeEntries,
  timeOffLedger,
  workCodes,
} from '@vibe/db/schema';
import {
  addDays,
  computeAnnualGrant,
  computePeriodAccrual,
  generatePayPeriods,
  type AccrualPolicyInput,
  type PayPeriodFrequency,
  type PolicyTier,
  type TimeOffBank,
} from '@vibe/core/payroll';

import type { Logger } from 'pino';

const BANK_USAGE_CATEGORY: Record<TimeOffBank, 'PTO' | 'SICK' | 'COMP_USED'> = {
  PTO: 'PTO',
  SICK: 'SICK',
  COMP: 'COMP_USED',
};

function policyInput(p: typeof accrualPolicies.$inferSelect): AccrualPolicyInput {
  return {
    method: p.method,
    hoursPerPeriod: p.hoursPerPeriod != null ? Number(p.hoursPerPeriod) : null,
    earnHours: p.earnHours != null ? Number(p.earnHours) : null,
    perWorkedHours: p.perWorkedHours != null ? Number(p.perWorkedHours) : null,
    annualGrantHours: p.annualGrantHours != null ? Number(p.annualGrantHours) : null,
    annualGrantTiming: p.annualGrantTiming ?? null,
    accrualWaitingDays: p.accrualWaitingDays,
    usageWaitingDays: p.usageWaitingDays,
    maxBalanceHours: p.maxBalanceHours != null ? Number(p.maxBalanceHours) : null,
    carryoverCapHours: p.carryoverCapHours != null ? Number(p.carryoverCapHours) : null,
  };
}

export async function bankBalance(
  db: Database,
  firmId: string,
  appUserId: string,
  bank: TimeOffBank,
): Promise<number> {
  const [credit] = await db
    .select({ total: sql<string>`COALESCE(SUM(${timeOffLedger.deltaHours}), 0)` })
    .from(timeOffLedger)
    .where(
      and(
        eq(timeOffLedger.firmId, firmId),
        eq(timeOffLedger.appUserId, appUserId),
        eq(timeOffLedger.bank, bank),
      ),
    );
  const [used] = await db
    .select({ total: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)` })
    .from(timeEntries)
    .innerJoin(workCodes, eq(workCodes.id, timeEntries.workCodeId))
    .where(
      and(
        eq(timeEntries.appUserId, appUserId),
        ne(timeEntries.status, 'ARCHIVED'),
        eq(workCodes.payrollCategory, BANK_USAGE_CATEGORY[bank]),
      ),
    );
  return Number(credit?.total ?? 0) - Number(used?.total ?? 0);
}

export async function runPayrollAccrual(
  db: Database,
  log: Logger,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<{
  firms: number;
  periodsEnsured: number;
  accrualsWritten: number;
  grantsWritten: number;
}> {
  const settingsRows = await db
    .select({
      firmId: firmSettings.firmId,
      frequency: firmSettings.payrollPeriodFrequency,
      anchorDate: firmSettings.payrollPeriodAnchorDate,
    })
    .from(firmSettings)
    .where(eq(firmSettings.payrollEnabled, true));

  let periodsEnsured = 0;
  let accrualsWritten = 0;
  let grantsWritten = 0;

  for (const fs of settingsRows) {
    const frequency = fs.frequency as PayPeriodFrequency;

    // Keep pay periods materialized ahead (same window as the API).
    const ranges = generatePayPeriods(
      frequency,
      fs.anchorDate,
      addDays(today, -90),
      addDays(today, 45),
    );
    if (ranges.length > 0) {
      const inserted = await db
        .insert(payPeriods)
        .values(ranges.map((r) => ({ firmId: fs.firmId, startDate: r.start, endDate: r.end })))
        .onConflictDoNothing()
        .returning({ id: payPeriods.id });
      periodsEnsured += inserted.length;
    }

    const assignments = await db
      .select({
        appUserId: accrualPolicyAssignments.appUserId,
        effectiveDate: accrualPolicyAssignments.effectiveDate,
        policy: accrualPolicies,
        hiredDate: appUsers.hiredDate,
        leftDate: appUsers.leftDate,
      })
      .from(accrualPolicyAssignments)
      .innerJoin(accrualPolicies, eq(accrualPolicies.id, accrualPolicyAssignments.policyId))
      .innerJoin(appUsers, eq(appUsers.id, accrualPolicyAssignments.appUserId))
      .where(
        and(
          eq(accrualPolicyAssignments.firmId, fs.firmId),
          isNull(accrualPolicyAssignments.endDate),
          eq(accrualPolicies.status, 'ACTIVE'),
          eq(appUsers.status, 'ACTIVE'),
          // Only full-timers accrue (locked decision).
          eq(appUsers.isFullTime, true),
        ),
      );
    if (assignments.length === 0) continue;

    const tierRows = await db
      .select()
      .from(accrualPolicyTiers)
      .where(
        inArray(accrualPolicyTiers.policyId, [...new Set(assignments.map((a) => a.policy.id))]),
      );
    const tiersByPolicy = new Map<string, PolicyTier[]>();
    for (const t of tierRows) {
      const list = tiersByPolicy.get(t.policyId) ?? [];
      list.push({ minYearsService: t.minYearsService, rateHours: Number(t.rateHours) });
      tiersByPolicy.set(t.policyId, list);
    }

    // Completed periods inside the generation window, oldest first.
    const completed = await db
      .select()
      .from(payPeriods)
      .where(
        and(
          eq(payPeriods.firmId, fs.firmId),
          sql`${payPeriods.endDate} < ${today}`,
          gte(payPeriods.endDate, addDays(today, -90)),
        ),
      )
      .orderBy(payPeriods.startDate);

    for (const a of assignments) {
      const policy = policyInput(a.policy);
      const tiers = tiersByPolicy.get(a.policy.id) ?? [];

      if (a.policy.method === 'ANNUAL_GRANT') {
        const balance = await bankBalance(db, fs.firmId, a.appUserId, a.policy.bank);
        const grant = computeAnnualGrant(policy, {
          hiredDate: a.hiredDate,
          leftDate: a.leftDate,
          today,
          currentBalance: balance,
          tiers,
        });
        if (grant) {
          const inserted = await db
            .insert(timeOffLedger)
            .values({
              firmId: fs.firmId,
              appUserId: a.appUserId,
              bank: a.policy.bank,
              deltaHours: grant.grantHours.toString(),
              reason: 'GRANT',
              policyId: a.policy.id,
              periodKey: grant.periodKey,
              note: `Annual grant (${a.policy.name})`,
            })
            .onConflictDoNothing()
            .returning({ id: timeOffLedger.id });
          if (inserted.length > 0) grantsWritten++;
        }
        continue;
      }

      for (const period of completed) {
        // Assignment must cover the period end.
        if (a.effectiveDate > period.endDate) continue;
        // Fresh balance each time so the max-balance clamp sees prior
        // periods' accruals (re-runs conflict away on period_key).
        const balance = await bankBalance(db, fs.firmId, a.appUserId, a.policy.bank);
        let hoursWorked = 0;
        if (a.policy.method === 'PER_HOURS_WORKED') {
          const [worked] = await db
            .select({ total: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)` })
            .from(timeEntries)
            .leftJoin(workCodes, eq(workCodes.id, timeEntries.workCodeId))
            .where(
              and(
                eq(timeEntries.appUserId, a.appUserId),
                ne(timeEntries.status, 'ARCHIVED'),
                gte(timeEntries.entryDate, period.startDate),
                lte(timeEntries.entryDate, period.endDate),
                sql`COALESCE(${workCodes.payrollCategory}, 'REGULAR') = 'REGULAR'`,
              ),
            );
          hoursWorked = Number(worked?.total ?? 0);
        }
        const accrued = computePeriodAccrual(policy, {
          hiredDate: a.hiredDate,
          leftDate: a.leftDate,
          periodEnd: period.endDate,
          hoursWorkedInPeriod: hoursWorked,
          currentBalance: balance,
          tiers,
        });
        if (accrued <= 0) continue;
        const inserted = await db
          .insert(timeOffLedger)
          .values({
            firmId: fs.firmId,
            appUserId: a.appUserId,
            bank: a.policy.bank,
            entryDate: period.endDate,
            deltaHours: accrued.toString(),
            reason: 'ACCRUAL',
            policyId: a.policy.id,
            payPeriodId: period.id,
            periodKey: `PP:${period.id}`,
            note: `Accrual ${period.startDate} → ${period.endDate} (${a.policy.name})`,
          })
          .onConflictDoNothing()
          .returning({ id: timeOffLedger.id });
        if (inserted.length > 0) accrualsWritten++;
      }
    }
  }

  log.info(
    { firms: settingsRows.length, periodsEnsured, accrualsWritten, grantsWritten },
    'payroll accrual sweep done',
  );
  return { firms: settingsRows.length, periodsEnsured, accrualsWritten, grantsWritten };
}
