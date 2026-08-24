// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Payroll timekeeping (0226): accrual policy CRUD + assignments, balance
// and ledger reads, manual ledger adjustments, pay-period generation and
// the per-period payroll review (regular/OT/PTO/sick/comp/holiday/unpaid
// per employee), per-employee approval, OT→comp conversion, and period
// lock/unlock. Payroll hours come from ordinary time entries; see
// balances.ts for the derived-usage model.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  accrualPolicies,
  accrualPolicyAssignments,
  accrualPolicyTiers,
  appUsers,
  firmSettings,
  payPeriodEmployees,
  payPeriods,
  timeEntries,
  timeOffLedger,
  workCodes,
} from '@vibe/db/schema';
import {
  addDays,
  attributePeriodTotals,
  generatePayPeriods,
  round2,
  type PayPeriodFrequency,
  type PeriodRange,
} from '@vibe/core/payroll';

import { emitAudit } from '../auth/audit';
import { requirePermission, userHasPermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { loadBalances } from './balances';

export interface PayrollRoutesDeps extends RbacDeps {
  db: Database | null;
}

function clientIp(req: Request): string {
  return (req.headers?.['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

const BankSchema = z.enum(['PTO', 'SICK', 'COMP']);

const PolicySchema = z.object({
  bank: BankSchema,
  name: z.string().min(1).max(120),
  method: z.enum(['FIXED_PER_PERIOD', 'PER_HOURS_WORKED', 'ANNUAL_GRANT']),
  hoursPerPeriod: z.number().positive().max(999).nullable().optional(),
  earnHours: z.number().positive().max(999).nullable().optional(),
  perWorkedHours: z.number().positive().max(9999).nullable().optional(),
  annualGrantHours: z.number().positive().max(9999).nullable().optional(),
  annualGrantTiming: z.enum(['CALENDAR_YEAR', 'ANNIVERSARY']).nullable().optional(),
  accrualWaitingDays: z.number().int().min(0).max(3650).optional(),
  usageWaitingDays: z.number().int().min(0).max(3650).optional(),
  maxBalanceHours: z.number().positive().max(99999).nullable().optional(),
  carryoverCapHours: z.number().min(0).max(99999).nullable().optional(),
});

const TiersSchema = z.object({
  tiers: z
    .array(
      z.object({
        minYearsService: z.number().int().min(0).max(80),
        rateHours: z.number().positive().max(9999),
      }),
    )
    .max(20),
});

const AdjustmentSchema = z.object({
  appUserId: z.string().uuid(),
  bank: BankSchema,
  deltaHours: z
    .number()
    .refine((n) => n !== 0, 'delta_hours_zero')
    .refine((n) => Math.abs(n) <= 9999, 'delta_hours_range'),
  reason: z.enum(['ADJUSTMENT', 'GRANT', 'COMP_EARNED']).default('ADJUSTMENT'),
  note: z.string().min(1).max(400),
});

export interface PayrollFirmConfig {
  payrollEnabled: boolean;
  frequency: PayPeriodFrequency;
  anchorDate: string | null;
  workweekStartDay: number;
  compOtMultiplier: number;
  holidayDefaultHours: number;
}

export async function loadPayrollConfig(db: Database, firmId: string): Promise<PayrollFirmConfig> {
  const [fs] = await db
    .select({
      payrollEnabled: firmSettings.payrollEnabled,
      frequency: firmSettings.payrollPeriodFrequency,
      anchorDate: firmSettings.payrollPeriodAnchorDate,
      workweekStartDay: firmSettings.payrollWorkweekStartDay,
      compOtMultiplier: firmSettings.payrollCompOtMultiplier,
      holidayDefaultHours: firmSettings.payrollHolidayDefaultHours,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  return {
    payrollEnabled: fs?.payrollEnabled ?? false,
    frequency: fs?.frequency ?? 'BIWEEKLY',
    anchorDate: fs?.anchorDate ?? null,
    workweekStartDay: fs?.workweekStartDay ?? 0,
    compOtMultiplier: Number(fs?.compOtMultiplier ?? 1.5),
    holidayDefaultHours: Number(fs?.holidayDefaultHours ?? 8),
  };
}

/**
 * Materialize pay_period rows covering [today − 90d, today + 45d].
 * Idempotent (unique firm_id + start_date, ON CONFLICT DO NOTHING);
 * shared with the nightly worker job.
 */
export async function ensurePayPeriods(
  db: Database,
  firmId: string,
  config: PayrollFirmConfig,
  today: string,
): Promise<void> {
  const ranges = generatePayPeriods(
    config.frequency,
    config.anchorDate,
    addDays(today, -90),
    addDays(today, 45),
  );
  if (ranges.length === 0) return;
  await db
    .insert(payPeriods)
    .values(ranges.map((r) => ({ firmId, startDate: r.start, endDate: r.end })))
    .onConflictDoNothing();
}

export interface EmployeePeriodRow {
  appUserId: string;
  fullName: string;
  overtimeExempt: boolean;
  isFullTime: boolean;
  standardHoursPerWeek: number;
  regularHours: number;
  otHours: number;
  compConvertedHours: number;
  actualWorkedHours: number;
  ptoHours: number;
  sickHours: number;
  compUsedHours: number;
  holidayHours: number;
  unpaidHours: number;
  missingDays: string[];
  approvedAt: string | null;
  approvedByAppUserId: string | null;
}

/**
 * The per-employee payroll rollup for one period. Worked (REGULAR)
 * hours are loaded from 6 days before period start so straddling
 * workweeks compute their OT correctly; category hours count only
 * inside the period.
 */
export async function computePeriodReview(
  db: Database,
  firmId: string,
  period: PeriodRange,
  config: PayrollFirmConfig,
): Promise<EmployeePeriodRow[]> {
  const users = await db
    .select({
      id: appUsers.id,
      fullName: appUsers.fullName,
      overtimeExempt: appUsers.overtimeExempt,
      isFullTime: appUsers.isFullTime,
      standardHoursPerWeek: appUsers.standardHoursPerWeek,
      hiredDate: appUsers.hiredDate,
      leftDate: appUsers.leftDate,
    })
    .from(appUsers)
    .where(and(eq(appUsers.firmId, firmId), eq(appUsers.status, 'ACTIVE')))
    .orderBy(appUsers.fullName);
  if (users.length === 0) return [];
  const userIds = users.map((u) => u.id);

  const entries = await db
    .select({
      appUserId: timeEntries.appUserId,
      entryDate: timeEntries.entryDate,
      hours: timeEntries.hours,
      category: sql<string>`COALESCE(${workCodes.payrollCategory}, 'REGULAR')`.as('category'),
    })
    .from(timeEntries)
    .leftJoin(workCodes, eq(workCodes.id, timeEntries.workCodeId))
    .where(
      and(
        inArray(timeEntries.appUserId, userIds),
        ne(timeEntries.status, 'ARCHIVED'),
        gte(timeEntries.entryDate, addDays(period.start, -6)),
        lte(timeEntries.entryDate, period.end),
      ),
    );

  const workedByUser = new Map<string, Record<string, number>>();
  const catByUser = new Map<string, Record<string, number>>();
  const daysWithAnyHours = new Map<string, Set<string>>();
  for (const e of entries) {
    const hours = Number(e.hours);
    if (e.category === 'REGULAR') {
      const daily = workedByUser.get(e.appUserId) ?? {};
      daily[e.entryDate] = (daily[e.entryDate] ?? 0) + hours;
      workedByUser.set(e.appUserId, daily);
    }
    if (e.entryDate >= period.start && e.entryDate <= period.end) {
      const cats = catByUser.get(e.appUserId) ?? {};
      cats[e.category] = (cats[e.category] ?? 0) + hours;
      catByUser.set(e.appUserId, cats);
      const days = daysWithAnyHours.get(e.appUserId) ?? new Set<string>();
      days.add(e.entryDate);
      daysWithAnyHours.set(e.appUserId, days);
    }
  }

  const approvals = await db
    .select()
    .from(payPeriodEmployees)
    .innerJoin(payPeriods, eq(payPeriods.id, payPeriodEmployees.payPeriodId))
    .where(
      and(
        eq(payPeriods.firmId, firmId),
        eq(payPeriods.startDate, period.start),
        eq(payPeriods.endDate, period.end),
      ),
    );
  const approvalByUser = new Map(
    approvals.map((a) => [a.pay_period_employee.appUserId, a.pay_period_employee]),
  );

  // Weekdays in the period, for the missing-day flags.
  const weekdays: string[] = [];
  for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
    const dow = new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay();
    if (dow >= 1 && dow <= 5) weekdays.push(d);
  }

  return users.map((u) => {
    const totals = attributePeriodTotals({
      period,
      dailyWorkedHours: workedByUser.get(u.id) ?? {},
      workweekStartDay: config.workweekStartDay,
      overtimeExempt: u.overtimeExempt,
      standardHoursPerWeek: Number(u.standardHoursPerWeek),
      frequency: config.frequency,
    });
    const cats = catByUser.get(u.id) ?? {};
    const approval = approvalByUser.get(u.id);
    const compConverted = Number(approval?.compConvertedHours ?? 0);
    const days = daysWithAnyHours.get(u.id) ?? new Set<string>();
    const missingDays = u.isFullTime
      ? weekdays.filter(
          (d) =>
            !days.has(d) && (!u.hiredDate || d >= u.hiredDate) && (!u.leftDate || d <= u.leftDate),
        )
      : [];
    return {
      appUserId: u.id,
      fullName: u.fullName,
      overtimeExempt: u.overtimeExempt,
      isFullTime: u.isFullTime,
      standardHoursPerWeek: Number(u.standardHoursPerWeek),
      regularHours: totals.regularHours,
      otHours: round2(Math.max(0, totals.otHours - compConverted)),
      compConvertedHours: compConverted,
      actualWorkedHours: totals.actualWorkedHours,
      ptoHours: round2(cats['PTO'] ?? 0),
      sickHours: round2(cats['SICK'] ?? 0),
      compUsedHours: round2(cats['COMP_USED'] ?? 0),
      holidayHours: round2(cats['HOLIDAY'] ?? 0),
      unpaidHours: round2(cats['UNPAID'] ?? 0),
      missingDays,
      approvedAt: approval?.approvedAt ? approval.approvedAt.toISOString() : null,
      approvedByAppUserId: approval?.approvedByAppUserId ?? null,
    };
  });
}

export function createPayrollRouter(deps: PayrollRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // ------------------------------------------------------------------
  // Accrual policies
  // ------------------------------------------------------------------

  router.get(
    '/policies',
    requirePermission(deps, 'payroll:policy:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(accrualPolicies)
        .where(
          and(eq(accrualPolicies.firmId, session.firmId), ne(accrualPolicies.status, 'ARCHIVED')),
        )
        .orderBy(accrualPolicies.bank, accrualPolicies.name);
      const tiers = items.length
        ? await deps.db
            .select()
            .from(accrualPolicyTiers)
            .where(
              inArray(
                accrualPolicyTiers.policyId,
                items.map((p) => p.id),
              ),
            )
            .orderBy(accrualPolicyTiers.minYearsService)
        : [];
      res.json({
        items: items.map((p) => ({
          ...p,
          tiers: tiers.filter((t) => t.policyId === p.id),
        })),
      });
    },
  );

  router.post(
    '/policies',
    requirePermission(deps, 'payroll:policy:manage'),
    async (req: Request, res: Response) => {
      const parsed = PolicySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const d = parsed.data;
      const [row] = await deps.db
        .insert(accrualPolicies)
        .values({
          firmId: session.firmId,
          bank: d.bank,
          name: d.name,
          method: d.method,
          hoursPerPeriod: d.hoursPerPeriod != null ? d.hoursPerPeriod.toString() : null,
          earnHours: d.earnHours != null ? d.earnHours.toString() : null,
          perWorkedHours: d.perWorkedHours != null ? d.perWorkedHours.toString() : null,
          annualGrantHours: d.annualGrantHours != null ? d.annualGrantHours.toString() : null,
          annualGrantTiming: d.annualGrantTiming ?? null,
          accrualWaitingDays: d.accrualWaitingDays ?? 0,
          usageWaitingDays: d.usageWaitingDays ?? 0,
          maxBalanceHours: d.maxBalanceHours != null ? d.maxBalanceHours.toString() : null,
          carryoverCapHours: d.carryoverCapHours != null ? d.carryoverCapHours.toString() : null,
        })
        .returning({ id: accrualPolicies.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'accrual_policy',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: d,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/policies/:id',
    requirePermission(deps, 'payroll:policy:manage'),
    async (req: Request, res: Response) => {
      const parsed = PolicySchema.partial()
        .extend({ status: z.enum(['ACTIVE', 'ARCHIVED']).optional() })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(accrualPolicies)
        .where(
          and(
            eq(accrualPolicies.id, req.params['id']!),
            eq(accrualPolicies.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const d = parsed.data;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (d.name != null) patch['name'] = d.name;
      if (d.method != null) patch['method'] = d.method;
      if (d.status != null) patch['status'] = d.status;
      if (d.annualGrantTiming !== undefined) patch['annualGrantTiming'] = d.annualGrantTiming;
      for (const k of [
        'hoursPerPeriod',
        'earnHours',
        'perWorkedHours',
        'annualGrantHours',
        'maxBalanceHours',
        'carryoverCapHours',
      ] as const) {
        if (d[k] !== undefined) patch[k] = d[k] != null ? String(d[k]) : null;
      }
      for (const k of ['accrualWaitingDays', 'usageWaitingDays'] as const) {
        if (d[k] !== undefined) patch[k] = d[k];
      }
      await deps.db.update(accrualPolicies).set(patch).where(eq(accrualPolicies.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'accrual_policy',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: prior,
        after: d,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.json({ ok: true });
    },
  );

  router.put(
    '/policies/:id/tiers',
    requirePermission(deps, 'payroll:policy:manage'),
    async (req: Request, res: Response) => {
      const parsed = TiersSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [prior] = await deps.db
        .select({ id: accrualPolicies.id })
        .from(accrualPolicies)
        .where(
          and(
            eq(accrualPolicies.id, req.params['id']!),
            eq(accrualPolicies.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db.transaction(async (tx) => {
        await tx.delete(accrualPolicyTiers).where(eq(accrualPolicyTiers.policyId, prior.id));
        if (parsed.data.tiers.length > 0) {
          await tx.insert(accrualPolicyTiers).values(
            parsed.data.tiers.map((t) => ({
              policyId: prior.id,
              minYearsService: t.minYearsService,
              rateHours: t.rateHours.toString(),
            })),
          );
        }
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'accrual_policy_tiers',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.json({ ok: true });
    },
  );

  // ------------------------------------------------------------------
  // Assignments
  // ------------------------------------------------------------------

  router.get(
    '/assignments',
    requirePermission(deps, 'payroll:policy:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const userId = uuidQueryParam(req.query['appUserId']);
      if (userId === 'invalid') {
        res.status(400).json({ error: 'invalid_app_user_id' });
        return;
      }
      const conds = [
        eq(accrualPolicyAssignments.firmId, session.firmId),
        isNull(accrualPolicyAssignments.endDate),
      ];
      if (userId) conds.push(eq(accrualPolicyAssignments.appUserId, userId));
      const items = await deps.db
        .select({
          id: accrualPolicyAssignments.id,
          appUserId: accrualPolicyAssignments.appUserId,
          policyId: accrualPolicyAssignments.policyId,
          bank: accrualPolicyAssignments.bank,
          effectiveDate: accrualPolicyAssignments.effectiveDate,
          policyName: accrualPolicies.name,
        })
        .from(accrualPolicyAssignments)
        .innerJoin(accrualPolicies, eq(accrualPolicies.id, accrualPolicyAssignments.policyId))
        .where(and(...conds));
      res.json({ items });
    },
  );

  router.post(
    '/assignments',
    requirePermission(deps, 'payroll:policy:manage'),
    async (req: Request, res: Response) => {
      const parsed = z
        .object({ appUserId: z.string().uuid(), policyId: z.string().uuid() })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [policy] = await deps.db
        .select()
        .from(accrualPolicies)
        .where(
          and(
            eq(accrualPolicies.id, parsed.data.policyId),
            eq(accrualPolicies.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!policy) {
        res.status(404).json({ error: 'policy_not_found' });
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const inserted = await deps.db.transaction(async (tx) => {
        // One active assignment per user × bank: end-date any current one.
        await tx
          .update(accrualPolicyAssignments)
          .set({ endDate: today })
          .where(
            and(
              eq(accrualPolicyAssignments.appUserId, parsed.data.appUserId),
              eq(accrualPolicyAssignments.bank, policy.bank),
              isNull(accrualPolicyAssignments.endDate),
            ),
          );
        const [row] = await tx
          .insert(accrualPolicyAssignments)
          .values({
            firmId: session.firmId,
            appUserId: parsed.data.appUserId,
            policyId: policy.id,
            bank: policy.bank,
            effectiveDate: today,
          })
          .returning({ id: accrualPolicyAssignments.id });
        return row;
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'accrual_policy_assignment',
        entityId: inserted?.id,
        actorAppUserId: session.appUserId,
        after: { ...parsed.data, bank: policy.bank },
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.status(201).json({ id: inserted?.id });
    },
  );

  router.delete(
    '/assignments/:id',
    requirePermission(deps, 'payroll:policy:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(accrualPolicyAssignments)
        .where(
          and(
            eq(accrualPolicyAssignments.id, req.params['id']!),
            eq(accrualPolicyAssignments.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!prior || prior.endDate) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      await deps.db
        .update(accrualPolicyAssignments)
        .set({ endDate: today })
        .where(eq(accrualPolicyAssignments.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'accrual_policy_assignment',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: prior,
        after: { endDate: today },
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.json({ ok: true });
    },
  );

  // ------------------------------------------------------------------
  // Balances + ledger
  // ------------------------------------------------------------------

  router.get(
    '/balances',
    requirePermission(deps, 'payroll:period:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const users = await deps.db
        .select({
          id: appUsers.id,
          fullName: appUsers.fullName,
          isFullTime: appUsers.isFullTime,
        })
        .from(appUsers)
        .where(and(eq(appUsers.firmId, session.firmId), eq(appUsers.status, 'ACTIVE')))
        .orderBy(appUsers.fullName);
      const balances = await loadBalances(
        deps.db,
        session.firmId,
        users.map((u) => u.id),
      );
      res.json({
        items: users.map((u) => ({
          appUserId: u.id,
          fullName: u.fullName,
          isFullTime: u.isFullTime,
          banks: balances.get(u.id) ?? [],
        })),
      });
    },
  );

  router.get(
    '/balances/me',
    requirePermission(deps, 'time_off:request:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ banks: [] });
        return;
      }
      const balances = await loadBalances(deps.db, session.firmId, [session.appUserId]);
      res.json({ banks: balances.get(session.appUserId) ?? [] });
    },
  );

  router.get(
    '/ledger',
    requirePermission(deps, 'time_off:request:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const userId = uuidQueryParam(req.query['appUserId']) ?? session.appUserId;
      if (userId === 'invalid') {
        res.status(400).json({ error: 'invalid_app_user_id' });
        return;
      }
      if (
        userId !== session.appUserId &&
        !(await userHasPermission(deps, session.appUserId, 'payroll:period:read'))
      ) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const items = await deps.db
        .select()
        .from(timeOffLedger)
        .where(and(eq(timeOffLedger.firmId, session.firmId), eq(timeOffLedger.appUserId, userId)))
        .orderBy(desc(timeOffLedger.createdAt))
        .limit(200);
      res.json({ items });
    },
  );

  // Manual balance adjustment — go-live starting balances, corrections,
  // comp grants. Append-only ledger row with a required note.
  router.post(
    '/ledger/adjustment',
    requirePermission(deps, 'payroll:period:manage'),
    async (req: Request, res: Response) => {
      const parsed = AdjustmentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [target] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, parsed.data.appUserId), eq(appUsers.firmId, session.firmId)))
        .limit(1);
      if (!target) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(timeOffLedger)
        .values({
          firmId: session.firmId,
          appUserId: parsed.data.appUserId,
          bank: parsed.data.bank,
          deltaHours: parsed.data.deltaHours.toString(),
          reason: parsed.data.reason,
          note: parsed.data.note,
          createdByAppUserId: session.appUserId,
        })
        .returning({ id: timeOffLedger.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'time_off_ledger',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.status(201).json({ id: row?.id });
    },
  );

  // ------------------------------------------------------------------
  // Pay periods + review
  // ------------------------------------------------------------------

  router.get(
    '/periods',
    requirePermission(deps, 'payroll:period:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const config = await loadPayrollConfig(deps.db, session.firmId);
      const today = new Date().toISOString().slice(0, 10);
      await ensurePayPeriods(deps.db, session.firmId, config, today);
      const items = await deps.db
        .select()
        .from(payPeriods)
        .where(eq(payPeriods.firmId, session.firmId))
        .orderBy(desc(payPeriods.startDate))
        .limit(30);
      res.json({ items, config });
    },
  );

  router.get(
    '/periods/:id/review',
    requirePermission(deps, 'payroll:period:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ employees: [] });
        return;
      }
      const [period] = await deps.db
        .select()
        .from(payPeriods)
        .where(and(eq(payPeriods.id, req.params['id']!), eq(payPeriods.firmId, session.firmId)))
        .limit(1);
      if (!period) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const config = await loadPayrollConfig(deps.db, session.firmId);
      const employees = await computePeriodReview(
        deps.db,
        session.firmId,
        { start: period.startDate, end: period.endDate },
        config,
      );
      res.json({ period, config, employees });
    },
  );

  async function loadPeriodForManage(
    db: Database,
    firmId: string,
    periodId: string,
  ): Promise<typeof payPeriods.$inferSelect | null> {
    const [period] = await db
      .select()
      .from(payPeriods)
      .where(and(eq(payPeriods.id, periodId), eq(payPeriods.firmId, firmId)))
      .limit(1);
    return period ?? null;
  }

  router.post(
    '/periods/:id/employees/:userId/approve',
    requirePermission(deps, 'payroll:period:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const period = await loadPeriodForManage(deps.db, session.firmId, req.params['id']!);
      if (!period) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (period.status === 'LOCKED') {
        res.status(409).json({ error: 'period_locked' });
        return;
      }
      await deps.db
        .insert(payPeriodEmployees)
        .values({
          payPeriodId: period.id,
          appUserId: req.params['userId']!,
          approvedAt: new Date(),
          approvedByAppUserId: session.appUserId,
        })
        .onConflictDoUpdate({
          target: [payPeriodEmployees.payPeriodId, payPeriodEmployees.appUserId],
          set: {
            approvedAt: new Date(),
            approvedByAppUserId: session.appUserId,
            updatedAt: new Date(),
          },
        });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'pay_period_employee',
        entityId: period.id,
        actorAppUserId: session.appUserId,
        after: { approved: true, appUserId: req.params['userId'] },
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.json({ ok: true });
    },
  );

  router.post(
    '/periods/:id/employees/:userId/unapprove',
    requirePermission(deps, 'payroll:period:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const period = await loadPeriodForManage(deps.db, session.firmId, req.params['id']!);
      if (!period) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (period.status === 'LOCKED') {
        res.status(409).json({ error: 'period_locked' });
        return;
      }
      await deps.db
        .update(payPeriodEmployees)
        .set({ approvedAt: null, approvedByAppUserId: null, updatedAt: new Date() })
        .where(
          and(
            eq(payPeriodEmployees.payPeriodId, period.id),
            eq(payPeriodEmployees.appUserId, req.params['userId']!),
          ),
        );
      res.json({ ok: true });
    },
  );

  // Convert OT hours to comp-time credit (× firm multiplier). Reduces
  // the period's reported OT via pay_period_employee.comp_converted_hours
  // and writes a COMP_EARNED ledger row; entries are never mutated.
  router.post(
    '/periods/:id/employees/:userId/convert-comp',
    requirePermission(deps, 'payroll:period:manage'),
    async (req: Request, res: Response) => {
      const parsed = z.object({ otHours: z.number().positive().max(999) }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const period = await loadPeriodForManage(deps.db, session.firmId, req.params['id']!);
      if (!period) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (period.status === 'LOCKED') {
        res.status(409).json({ error: 'period_locked' });
        return;
      }
      const config = await loadPayrollConfig(deps.db, session.firmId);
      const userId = req.params['userId']!;
      const compHours = round2(parsed.data.otHours * config.compOtMultiplier);
      await deps.db.transaction(async (tx) => {
        await tx
          .insert(payPeriodEmployees)
          .values({
            payPeriodId: period.id,
            appUserId: userId,
            compConvertedHours: parsed.data.otHours.toString(),
          })
          .onConflictDoUpdate({
            target: [payPeriodEmployees.payPeriodId, payPeriodEmployees.appUserId],
            set: {
              compConvertedHours: sql`${payPeriodEmployees.compConvertedHours} + ${parsed.data.otHours}`,
              updatedAt: new Date(),
            },
          });
        await tx.insert(timeOffLedger).values({
          firmId: session.firmId,
          appUserId: userId,
          bank: 'COMP',
          deltaHours: compHours.toString(),
          reason: 'COMP_EARNED',
          payPeriodId: period.id,
          note: `OT→comp: ${parsed.data.otHours}h OT × ${config.compOtMultiplier}`,
          createdByAppUserId: session.appUserId,
        });
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'time_off_ledger',
        entityId: period.id,
        actorAppUserId: session.appUserId,
        after: { convertComp: parsed.data.otHours, compHours, appUserId: userId },
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.json({ ok: true, compHours });
    },
  );

  router.post(
    '/periods/:id/lock',
    requirePermission(deps, 'payroll:period:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const period = await loadPeriodForManage(deps.db, session.firmId, req.params['id']!);
      if (!period) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (period.status === 'LOCKED') {
        res.status(409).json({ error: 'already_locked' });
        return;
      }
      await deps.db
        .update(payPeriods)
        .set({ status: 'LOCKED', lockedAt: new Date(), lockedByAppUserId: session.appUserId })
        .where(eq(payPeriods.id, period.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'pay_period',
        entityId: period.id,
        actorAppUserId: session.appUserId,
        before: { status: period.status },
        after: { status: 'LOCKED' },
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.json({ ok: true });
    },
  );

  router.post(
    '/periods/:id/unlock',
    requirePermission(deps, 'payroll:period:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const period = await loadPeriodForManage(deps.db, session.firmId, req.params['id']!);
      if (!period) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (period.status !== 'LOCKED') {
        res.status(409).json({ error: 'not_locked' });
        return;
      }
      await deps.db
        .update(payPeriods)
        .set({ status: 'OPEN', lockedAt: null, lockedByAppUserId: null })
        .where(eq(payPeriods.id, period.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'pay_period',
        entityId: period.id,
        actorAppUserId: session.appUserId,
        before: { status: 'LOCKED' },
        after: { status: 'OPEN' },
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.json({ ok: true });
    },
  );

  return router;
}
