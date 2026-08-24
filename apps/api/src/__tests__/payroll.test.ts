// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0226 — payroll timekeeping:
//  - accrual job is idempotent (re-run writes no duplicate ledger rows)
//  - manual admin adjustment writes an append-only ledger row
//  - time-off request → approve creates entries on the firm-admin
//    engagement as the requester and the balance drops (derived usage)
//  - direct sick logging deducts; archiving the entry restores balance
//  - overdraw warns on the 201 body but never blocks
//  - payroll lock: entries dated in a LOCKED pay period refuse
//    create/PATCH/DELETE with 409 payroll_locked
//  - period review: weekly-over-40 OT for non-exempt; exempt shows
//    standard hours with actuals carried separately

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';

import {
  accrualPolicies,
  accrualPolicyAssignments,
  appUsers,
  engagements,
  payPeriods,
  staffRateSnapshotEntries,
  staffRateSnapshots,
  timeEntries,
  timeOffLedger,
  timeOffRequestDays,
  workCodes,
} from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTimeEntryRouter } from '../time-entries/routes';
import { createPayrollRouter, computePeriodReview } from '../payroll/routes';
import { createTimeOffRouter } from '../payroll/time-off';
import { runPayrollAccrual } from '../../../worker/src/jobs/payroll-accrual';

let h: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let approverId: string;
let sickCodeId: string;

const log = pino({ level: 'silent' });
const TODAY = new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  h = await buildPgliteHarness();
  seed = await seedMinimalFirm(h.db);
  // The seed engagement doubles as the firm-admin engagement (0208).
  await h.db
    .update(engagements)
    .set({ firmAdmin: true, status: 'ACTIVE' })
    .where(eq(engagements.id, seed.engagementId));
  // Rate snapshot so createTimeEntryCore resolves a rate for the user.
  const [snap] = await h.db
    .insert(staffRateSnapshots)
    .values({ appUserId: seed.appUserId, effectiveDate: '2020-01-01', costRateCents: 12000 })
    .returning({ id: staffRateSnapshots.id });
  await h.db.insert(staffRateSnapshotEntries).values({
    snapshotId: snap!.id,
    rateCodeId: seed.rateCodeId,
    billRateCents: 30000,
  });
  // Second user approves time off (no self-approval).
  const approver = await h.db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name) VALUES (${seed.firmId}, 'p@test.example', 'Pat Partner') RETURNING id`,
  );
  approverId = (approver as unknown as { rows: { id: string }[] }).rows[0]!.id;
  // Payroll work codes (the 0226 seed no-ops on an empty DB).
  await h.db.insert(workCodes).values({
    firmId: seed.firmId,
    serviceLineId: seed.serviceLineId,
    key: 'pto',
    name: 'PTO / Vacation',
    billableDefault: false,
    payrollCategory: 'PTO',
  });
  const [sick] = await h.db
    .insert(workCodes)
    .values({
      firmId: seed.firmId,
      serviceLineId: seed.serviceLineId,
      key: 'sick_leave',
      name: 'Sick leave',
      billableDefault: false,
      payrollCategory: 'SICK',
    })
    .returning({ id: workCodes.id });
  sickCodeId = sick!.id;
  // Firm settings with payroll enabled, weekly periods anchored Monday
  // 2026-01-05, Monday workweeks.
  await h.db.execute(
    sql`INSERT INTO firm_settings (firm_id, payroll_enabled, payroll_period_frequency, payroll_period_anchor_date, payroll_workweek_start_day)
        VALUES (${seed.firmId}, true, 'WEEKLY', '2026-01-05', 1)`,
  );
});
afterEach(async () => {
  await h.close();
});

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}
async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const chain = route.stack;
  for (let i = 0; i < chain.length - 1; i++) {
    let advanced = false;
    await (chain[i]!.handle as (rq: unknown, rs: unknown, nx: () => void) => unknown)(
      req,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(req, res);
  return res;
}
function req(
  body: unknown,
  params: Record<string, string> = {},
  asUser?: string,
  query: Record<string, string> = {},
): Record<string, unknown> {
  return {
    body: body ?? {},
    params,
    query,
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: asUser ?? seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

function fakeRoles(): Map<string, RoleSlug[]> {
  return new Map<string, RoleSlug[]>([
    [seed.appUserId, ['staff']],
    [approverId, ['partner']],
  ]);
}
function timeRouter() {
  return createTimeEntryRouter({ db: h.db, fakeUserRoles: fakeRoles() });
}
function payrollRouter() {
  return createPayrollRouter({ db: h.db, fakeUserRoles: fakeRoles() });
}
function timeOffRouter() {
  return createTimeOffRouter({ db: h.db, fakeUserRoles: fakeRoles() });
}

async function ptoBalanceOf(userId: string): Promise<{ accrued: number; used: number }> {
  const [credit] = await h.db
    .select({ total: sql<string>`COALESCE(SUM(${timeOffLedger.deltaHours}), 0)` })
    .from(timeOffLedger)
    .where(sql`${timeOffLedger.appUserId} = ${userId} AND ${timeOffLedger.bank} = 'PTO'`);
  const [used] = await h.db
    .select({ total: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)` })
    .from(timeEntries)
    .innerJoin(workCodes, eq(workCodes.id, timeEntries.workCodeId))
    .where(
      sql`${timeEntries.appUserId} = ${userId} AND ${workCodes.payrollCategory} = 'PTO' AND ${timeEntries.status} <> 'ARCHIVED'`,
    );
  return { accrued: Number(credit?.total ?? 0), used: Number(used?.total ?? 0) };
}

describe('payroll accrual job', () => {
  it('accrues per completed period once — re-run writes nothing new', async () => {
    const [policy] = await h.db
      .insert(accrualPolicies)
      .values({
        firmId: seed.firmId,
        bank: 'PTO',
        name: 'Standard PTO',
        method: 'FIXED_PER_PERIOD',
        hoursPerPeriod: '4',
      })
      .returning({ id: accrualPolicies.id });
    await h.db.insert(accrualPolicyAssignments).values({
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      policyId: policy!.id,
      bank: 'PTO',
      effectiveDate: '2026-01-05',
    });
    const first = await runPayrollAccrual(h.db, log, '2026-08-24');
    expect(first.accrualsWritten).toBeGreaterThan(0);
    const second = await runPayrollAccrual(h.db, log, '2026-08-24');
    expect(second.accrualsWritten).toBe(0);
    const rows = await h.db
      .select()
      .from(timeOffLedger)
      .where(eq(timeOffLedger.appUserId, seed.appUserId));
    expect(rows.length).toBe(first.accrualsWritten);
    expect(rows.every((r) => Number(r.deltaHours) === 4)).toBe(true);
  });

  it('part-time staff do not accrue', async () => {
    await h.db.update(appUsers).set({ isFullTime: false }).where(eq(appUsers.id, seed.appUserId));
    const [policy] = await h.db
      .insert(accrualPolicies)
      .values({
        firmId: seed.firmId,
        bank: 'PTO',
        name: 'Standard PTO',
        method: 'FIXED_PER_PERIOD',
        hoursPerPeriod: '4',
      })
      .returning({ id: accrualPolicies.id });
    await h.db.insert(accrualPolicyAssignments).values({
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      policyId: policy!.id,
      bank: 'PTO',
      effectiveDate: '2026-01-05',
    });
    const run = await runPayrollAccrual(h.db, log, '2026-08-24');
    expect(run.accrualsWritten).toBe(0);
  });
});

describe('manual ledger adjustment', () => {
  it('partner posts a signed adjustment with a note; staff cannot', async () => {
    const r = await invoke(
      payrollRouter(),
      'post',
      '/ledger/adjustment',
      req(
        { appUserId: seed.appUserId, bank: 'PTO', deltaHours: 40, note: 'Go-live balance' },
        {},
        approverId,
      ),
    );
    expect(r.statusCode).toBe(201);
    const bal = await ptoBalanceOf(seed.appUserId);
    expect(bal.accrued).toBe(40);

    const denied = await invoke(
      payrollRouter(),
      'post',
      '/ledger/adjustment',
      req({ appUserId: seed.appUserId, bank: 'PTO', deltaHours: 40, note: 'nope' }),
    );
    expect(denied.statusCode).toBe(403);
  });
});

describe('time-off request lifecycle', () => {
  it('request → approve creates entries as the requester and deducts the bank', async () => {
    const create = await invoke(
      timeOffRouter(),
      'post',
      '/requests',
      req({
        kind: 'PTO',
        startDate: TODAY,
        endDate: TODAY,
        days: [{ day: TODAY, hours: 8 }],
      }),
    );
    expect(create.statusCode).toBe(201);
    const requestId = (create.jsonBody as { id: string }).id;

    // Self-approval refused.
    const selfTry = await invoke(
      timeOffRouter(),
      'post',
      '/requests/:id/approve',
      req({}, { id: requestId }),
    );
    expect(selfTry.statusCode).toBe(403); // staff lacks time_off:approve

    const approve = await invoke(
      timeOffRouter(),
      'post',
      '/requests/:id/approve',
      req({}, { id: requestId }, approverId),
    );
    expect(approve.statusCode).toBe(200);
    expect((approve.jsonBody as { entriesCreated: number }).entriesCreated).toBe(1);
    // Overdrawn (0 accrued − 8 used) → warning present, not a block.
    expect((approve.jsonBody as { warning?: string }).warning).toContain('negative');

    const [day] = await h.db.select().from(timeOffRequestDays);
    expect(day!.timeEntryId).toBeTruthy();
    const [entry] = await h.db
      .select()
      .from(timeEntries)
      .where(eq(timeEntries.id, day!.timeEntryId!));
    expect(entry!.appUserId).toBe(seed.appUserId); // requester, not approver
    expect(entry!.engagementId).toBe(seed.engagementId); // firm-admin engagement
    expect(entry!.billableFlag).toBe(false);
    const bal = await ptoBalanceOf(seed.appUserId);
    expect(bal.used).toBe(8);
  });

  it('approver cannot approve their own request', async () => {
    // Approver needs a rate snapshot for entry creation — not reached
    // here, but the request itself is theirs.
    const create = await invoke(
      timeOffRouter(),
      'post',
      '/requests',
      req(
        { kind: 'PTO', startDate: TODAY, endDate: TODAY, days: [{ day: TODAY, hours: 8 }] },
        {},
        approverId,
      ),
    );
    const requestId = (create.jsonBody as { id: string }).id;
    const r = await invoke(
      timeOffRouter(),
      'post',
      '/requests/:id/approve',
      req({}, { id: requestId }, approverId),
    );
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { error: string }).error).toBe('cannot_self_approve');
  });
});

describe('direct logging + derived usage', () => {
  it('sick entry deducts; archiving it restores the balance', async () => {
    const create = await invoke(
      timeRouter(),
      'post',
      '/',
      req({ engagementId: seed.engagementId, workCodeId: sickCodeId, entryDate: TODAY, hours: 8 }),
    );
    expect(create.statusCode).toBe(201);
    const entryId = (create.jsonBody as { id: string }).id;
    // Overdraw warning on the 201 body (0 accrued), never a block.
    expect((create.jsonBody as { payrollWarning?: string }).payrollWarning).toContain('negative');

    const [used] = await h.db
      .select({ total: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)` })
      .from(timeEntries)
      .innerJoin(workCodes, eq(workCodes.id, timeEntries.workCodeId))
      .where(sql`${workCodes.payrollCategory} = 'SICK' AND ${timeEntries.status} <> 'ARCHIVED'`);
    expect(Number(used!.total)).toBe(8);

    const del = await invoke(timeRouter(), 'delete', '/:id', req({}, { id: entryId }));
    expect(del.statusCode).toBe(200);
    const [after] = await h.db
      .select({ total: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)` })
      .from(timeEntries)
      .innerJoin(workCodes, eq(workCodes.id, timeEntries.workCodeId))
      .where(sql`${workCodes.payrollCategory} = 'SICK' AND ${timeEntries.status} <> 'ARCHIVED'`);
    expect(Number(after!.total)).toBe(0);
  });
});

describe('payroll lock', () => {
  it('locked pay period freezes create, PATCH, and DELETE with 409 payroll_locked', async () => {
    // An entry created while the period is open.
    const create = await invoke(
      timeRouter(),
      'post',
      '/',
      req({ engagementId: seed.engagementId, entryDate: TODAY, hours: 2 }),
    );
    expect(create.statusCode).toBe(201);
    const entryId = (create.jsonBody as { id: string }).id;

    await h.db.insert(payPeriods).values({
      firmId: seed.firmId,
      startDate: TODAY,
      endDate: TODAY,
      status: 'LOCKED',
      lockedAt: new Date(),
    });

    const blockedCreate = await invoke(
      timeRouter(),
      'post',
      '/',
      req({ engagementId: seed.engagementId, entryDate: TODAY, hours: 1 }),
    );
    expect(blockedCreate.statusCode).toBe(409);
    expect((blockedCreate.jsonBody as { error: string }).error).toBe('payroll_locked');

    const blockedPatch = await invoke(
      timeRouter(),
      'patch',
      '/:id',
      req({ hours: 3 }, { id: entryId }),
    );
    expect(blockedPatch.statusCode).toBe(409);
    expect((blockedPatch.jsonBody as { error: string }).error).toBe('payroll_locked');

    const blockedDelete = await invoke(timeRouter(), 'delete', '/:id', req({}, { id: entryId }));
    expect(blockedDelete.statusCode).toBe(409);

    // Billing-lock semantics untouched: unlock the period and the entry
    // edits normally again.
    await h.db.update(payPeriods).set({ status: 'OPEN' }).where(eq(payPeriods.firmId, seed.firmId));
    const patchOk = await invoke(timeRouter(), 'patch', '/:id', req({ hours: 3 }, { id: entryId }));
    expect(patchOk.statusCode).toBe(200);
  });
});

describe('period review', () => {
  it('weekly-over-40 OT for non-exempt; exempt shows standard hours + actuals', async () => {
    await h.db
      .update(appUsers)
      .set({ overtimeExempt: false, standardHoursPerWeek: '40.00' })
      .where(eq(appUsers.id, seed.appUserId));
    // Mon–Fri 9h each on the week of 2026-08-17 (Monday workweek): 45h.
    for (const day of ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21']) {
      await h.db.insert(timeEntries).values({
        engagementId: seed.engagementId,
        appUserId: seed.appUserId,
        workCodeId: seed.workCodeId,
        entryDate: day,
        hours: '9.00',
        standardRateSnapshotCents: 30000,
        standardAmountCents: 270000,
      });
    }
    const config = {
      payrollEnabled: true,
      frequency: 'WEEKLY' as const,
      anchorDate: '2026-01-05',
      workweekStartDay: 1,
      compOtMultiplier: 1.5,
      holidayDefaultHours: 8,
    };
    const rows = await computePeriodReview(
      h.db,
      seed.firmId,
      { start: '2026-08-17', end: '2026-08-23' },
      config,
    );
    const me = rows.find((r) => r.appUserId === seed.appUserId)!;
    expect(me.actualWorkedHours).toBe(45);
    expect(me.otHours).toBe(5);
    expect(me.regularHours).toBe(40);

    // Exempt: standard hours drive pay; actuals informational; no OT.
    await h.db
      .update(appUsers)
      .set({ overtimeExempt: true })
      .where(eq(appUsers.id, seed.appUserId));
    const rows2 = await computePeriodReview(
      h.db,
      seed.firmId,
      { start: '2026-08-17', end: '2026-08-23' },
      config,
    );
    const me2 = rows2.find((r) => r.appUserId === seed.appUserId)!;
    expect(me2.otHours).toBe(0);
    expect(me2.regularHours).toBe(40); // standard weekly hours
    expect(me2.actualWorkedHours).toBe(45);
  });
});

// ---------------------------------------------------------------------
// Code-review regression fixes
// ---------------------------------------------------------------------

describe('payroll lock covers every mutation path', () => {
  async function lockToday(): Promise<void> {
    await h.db.insert(payPeriods).values({
      firmId: seed.firmId,
      startDate: TODAY,
      endDate: TODAY,
      status: 'LOCKED',
      lockedAt: new Date(),
    });
  }

  it('bulk-from-template refuses dates inside a locked period', async () => {
    await lockToday();
    const r = await invoke(
      timeRouter(),
      'post',
      '/bulk-from-template',
      req({
        template: { engagementId: seed.engagementId, hours: 2 },
        dates: [TODAY],
      }),
    );
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { error: string }).error).toBe('payroll_locked');
  });

  it('bulk-status skips (never archives) entries dated in a locked period', async () => {
    const create = await invoke(
      timeRouter(),
      'post',
      '/',
      req({ engagementId: seed.engagementId, entryDate: TODAY, hours: 2 }),
    );
    const entryId = (create.jsonBody as { id: string }).id;
    await lockToday();
    const r = await invoke(
      timeRouter(),
      'post',
      '/bulk-status',
      req({ ids: [entryId], status: 'ARCHIVED' }, {}, approverId),
    );
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { updated: number }).updated).toBe(0);
    expect((r.jsonBody as { payrollSkipped: number }).payrollSkipped).toBe(1);
    const [row] = await h.db.select().from(timeEntries).where(eq(timeEntries.id, entryId));
    expect(row!.status).not.toBe('ARCHIVED');
  });

  it('split and write-off refuse entries dated in a locked period', async () => {
    const create = await invoke(
      timeRouter(),
      'post',
      '/',
      req({ engagementId: seed.engagementId, entryDate: TODAY, hours: 2 }),
    );
    const entryId = (create.jsonBody as { id: string }).id;
    await lockToday();
    const split = await invoke(
      timeRouter(),
      'post',
      '/:id/split',
      req({ splits: [{ hours: 1 }, { hours: 1 }] }, { id: entryId }, approverId),
    );
    expect(split.statusCode).toBe(409);
    expect((split.jsonBody as { error: string }).error).toBe('payroll_locked');
    const wo = await invoke(
      timeRouter(),
      'post',
      '/:id/write-off',
      req({}, { id: entryId }, approverId),
    );
    expect(wo.statusCode).toBe(409);
    expect((wo.jsonBody as { error: string }).error).toBe('payroll_locked');
  });
});

describe('time-off approval of old dates', () => {
  it('approval bypasses the late-entry lockout (the sign-off IS the review)', async () => {
    // 30 days back — far outside the default 14-day window.
    const oldDay = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const create = await invoke(
      timeOffRouter(),
      'post',
      '/requests',
      req({
        kind: 'SICK',
        startDate: oldDay,
        endDate: oldDay,
        days: [{ day: oldDay, hours: 8 }],
      }),
    );
    expect(create.statusCode).toBe(201);
    const requestId = (create.jsonBody as { id: string }).id;
    const approve = await invoke(
      timeOffRouter(),
      'post',
      '/requests/:id/approve',
      req({}, { id: requestId }, approverId),
    );
    expect(approve.statusCode).toBe(200);
    expect((approve.jsonBody as { entriesCreated: number }).entriesCreated).toBe(1);
  });
});

describe('convert-comp validation', () => {
  it('rejects converting more OT than the employee actually has', async () => {
    // No OT at all → any conversion is rejected.
    const [period] = await h.db
      .insert(payPeriods)
      .values({ firmId: seed.firmId, startDate: TODAY, endDate: TODAY })
      .returning({ id: payPeriods.id });
    const r = await invoke(
      payrollRouter(),
      'post',
      '/periods/:id/employees/:userId/convert-comp',
      req({ otHours: 50 }, { id: period!.id, userId: seed.appUserId }, approverId),
    );
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('exceeds_remaining_ot');
  });
});

describe('lock snapshots period totals', () => {
  it('a locked period is immune to later work-code category changes', async () => {
    await h.db
      .update(appUsers)
      .set({ overtimeExempt: false })
      .where(eq(appUsers.id, seed.appUserId));
    // 8h logged today with the SICK code.
    await invoke(
      timeRouter(),
      'post',
      '/',
      req({ engagementId: seed.engagementId, workCodeId: sickCodeId, entryDate: TODAY, hours: 8 }),
    );
    const [period] = await h.db
      .insert(payPeriods)
      .values({ firmId: seed.firmId, startDate: TODAY, endDate: TODAY })
      .returning({ id: payPeriods.id });
    const lock = await invoke(
      payrollRouter(),
      'post',
      '/periods/:id/lock',
      req({}, { id: period!.id }, approverId),
    );
    expect(lock.statusCode).toBe(200);
    const before = await invoke(
      payrollRouter(),
      'get',
      '/periods/:id/review',
      req({}, { id: period!.id }, approverId),
    );
    const rowBefore = (
      before.jsonBody as { employees: Array<{ appUserId: string; sickHours: number }> }
    ).employees.find((e) => e.appUserId === seed.appUserId)!;
    expect(rowBefore.sickHours).toBe(8);

    // Recategorize the sick code AFTER lock — the frozen period must not move.
    await h.db
      .update(workCodes)
      .set({ payrollCategory: 'REGULAR' })
      .where(eq(workCodes.id, sickCodeId));
    const after = await invoke(
      payrollRouter(),
      'get',
      '/periods/:id/review',
      req({}, { id: period!.id }, approverId),
    );
    const rowAfter = (
      after.jsonBody as { employees: Array<{ appUserId: string; sickHours: number }> }
    ).employees.find((e) => e.appUserId === seed.appUserId)!;
    expect(rowAfter.sickHours).toBe(8);
  });
});

describe('carryover uses the year-end balance', () => {
  it('does not forfeit the new year annual grant written before it runs', async () => {
    const { runPayrollCarryover } = await import('../../../worker/src/jobs/payroll-carryover');
    const [policy] = await h.db
      .insert(accrualPolicies)
      .values({
        firmId: seed.firmId,
        bank: 'PTO',
        name: 'Granted PTO',
        method: 'ANNUAL_GRANT',
        annualGrantHours: '80',
        annualGrantTiming: 'CALENDAR_YEAR',
        carryoverCapHours: '40',
      })
      .returning({ id: accrualPolicies.id });
    await h.db.insert(accrualPolicyAssignments).values({
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      policyId: policy!.id,
      bank: 'PTO',
      effectiveDate: '2026-01-01',
    });
    // Balance exactly at the 40h cap on Dec 31 → nothing to forfeit.
    await h.db.insert(timeOffLedger).values({
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      bank: 'PTO',
      entryDate: '2026-12-31',
      deltaHours: '40',
      reason: 'ADJUSTMENT',
      note: 'year-end balance',
    });
    // The new year's grant lands first (accrual job runs at 02:10).
    await h.db.insert(timeOffLedger).values({
      firmId: seed.firmId,
      appUserId: seed.appUserId,
      bank: 'PTO',
      entryDate: '2027-01-01',
      deltaHours: '80',
      reason: 'GRANT',
      periodKey: 'ANNUAL:2027',
      note: 'Annual grant',
    });
    const run = await runPayrollCarryover(h.db, log, '2027-01-01');
    // 40h at year end is within the cap — no forfeit, grant untouched.
    expect(run.forfeits).toBe(0);
    const rows = await h.db
      .select()
      .from(timeOffLedger)
      .where(eq(timeOffLedger.reason, 'CARRYOVER_FORFEIT'));
    expect(rows.length).toBe(0);
  });
});
