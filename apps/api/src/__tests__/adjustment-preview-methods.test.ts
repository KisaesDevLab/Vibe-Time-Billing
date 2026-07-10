// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Regression coverage for the three allocation methods the dialog was
// failing to drive: SPECIFIC_ENTRIES, CUSTOM_WEIGHTED, PARTNER_ABSORBS.
// The bug was front-end (the dialog omitted entrySelections/weights and
// swallowed the backend `detail`). These tests lock the server contract
// the fixed dialog now satisfies: given the right payload, preview runs
// and returns per-entry allocations; given a partner-less batch,
// PARTNER_ABSORBS surfaces the real "no partner entries available" detail.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createAdjustmentRouter } from '../adjustments/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

interface FakeReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  header(name: string): string | undefined;
  get(name: string): string | undefined;
}
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
  method: 'get' | 'post',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}
function makeReq(over: Partial<FakeReq> & { firmId: string; appUserId: string }): FakeReq {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: over.firmId, appUserId: over.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
    ...over,
  };
}

async function insertUser(
  db: PgliteHarness['db'],
  firmId: string,
  email: string,
  name: string,
): Promise<string> {
  const r = await db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
        VALUES (${firmId}, ${email}, ${name}, ${name}, 'X') RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

async function assignRole(
  db: PgliteHarness['db'],
  firmId: string,
  appUserId: string,
  roleName: string,
): Promise<void> {
  const r = await db.execute(
    sql`INSERT INTO role (firm_id, name, system_flag) VALUES (${firmId}, ${roleName}, true)
        RETURNING id`,
  );
  const roleId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await db.execute(
    sql`INSERT INTO user_role (app_user_id, role_id) VALUES (${appUserId}, ${roleId})`,
  );
}

async function insertBatch(
  db: PgliteHarness['db'],
  engagementId: string,
  createdById: string,
): Promise<string> {
  const r = await db.execute(
    sql`INSERT INTO billing_batch (engagement_id, period_start, period_end, status, created_by_id)
        VALUES (${engagementId}, '2026-04-01', '2026-04-30', 'DRAFT', ${createdById})
        RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

async function insertEntry(
  db: PgliteHarness['db'],
  args: {
    engagementId: string;
    appUserId: string;
    workCodeId: string;
    batchId: string;
    hours: string;
    standardAmountCents: number;
  },
): Promise<string> {
  const rate = Math.round(args.standardAmountCents / Number(args.hours));
  const r = await db.execute(
    sql`INSERT INTO time_entry
          (engagement_id, app_user_id, work_code_id, entry_date, hours,
           standard_rate_snapshot_cents, standard_amount_cents, in_scope_flag,
           description, status, billing_batch_id)
        VALUES (${args.engagementId}, ${args.appUserId}, ${args.workCodeId}, '2026-04-15',
                ${args.hours}, ${rate}, ${args.standardAmountCents}, false, 'work',
                'SUBMITTED', ${args.batchId})
        RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

async function setAction(
  db: PgliteHarness['db'],
  batchId: string,
  timeEntryId: string,
  action: 'INCLUDE' | 'DEFER' | 'WRITE_OFF',
): Promise<void> {
  await db.execute(
    sql`INSERT INTO billing_batch_entry (billing_batch_id, time_entry_id, action)
        VALUES (${batchId}, ${timeEntryId}, ${action})`,
  );
}

function buildRouter(db: PgliteHarness['db']): express.Router {
  return createAdjustmentRouter({
    db,
    // invoke() calls only the terminal handler, so middleware is bypassed;
    // these satisfy the deps shape at router-build time.
    requireStepUp: (_req, _res, next) => next(),
    fakeUserRoles: new Map(),
  });
}

describe('adjustment preview — specific / weighted / partner-absorbs', () => {
  it('SPECIFIC_ENTRIES: per-entry signed amounts summing to total → per-entry rows', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const u2 = await insertUser(harness.db, seed.firmId, 'b@test.example', 'Bea');
    const batchId = await insertBatch(harness.db, seed.engagementId, seed.appUserId);
    const e1 = await insertEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      batchId,
      hours: '4.00',
      standardAmountCents: 80000,
    });
    const e2 = await insertEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: u2,
      workCodeId: seed.workCodeId,
      batchId,
      hours: '2.00',
      standardAmountCents: 40000,
    });

    const router = buildRouter(harness.db);
    const r = await invoke(router, 'post', '/preview', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          billingBatchId: batchId,
          method: 'TIME',
          allocationMethod: 'SPECIFIC_ENTRIES',
          totalAmountCents: -30000,
          reasonCodeId: '00000000-0000-0000-0000-000000000000',
          entrySelections: [
            { entryId: e1, amountCents: -20000 },
            { entryId: e2, amountCents: -10000 },
          ],
        },
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      allocations: { timeEntryId: string; adjustmentAmountCents: number }[];
    };
    const byEntry = new Map(body.allocations.map((a) => [a.timeEntryId, a.adjustmentAmountCents]));
    expect(byEntry.get(e1)).toBe(-20000);
    expect(byEntry.get(e2)).toBe(-10000);
  });

  it('PRO_RATA excludes DEFER / WRITE_OFF entries (INCLUDE-only base)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const batchId = await insertBatch(harness.db, seed.engagementId, seed.appUserId);
    const eInclude = await insertEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      batchId,
      hours: '4.00',
      standardAmountCents: 80000,
    });
    const eDefer = await insertEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      batchId,
      hours: '2.00',
      standardAmountCents: 40000,
    });
    const eWriteOff = await insertEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      batchId,
      hours: '1.00',
      standardAmountCents: 20000,
    });
    await setAction(harness.db, batchId, eInclude, 'INCLUDE');
    await setAction(harness.db, batchId, eDefer, 'DEFER');
    await setAction(harness.db, batchId, eWriteOff, 'WRITE_OFF');

    const router = buildRouter(harness.db);
    const r = await invoke(router, 'post', '/preview', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          billingBatchId: batchId,
          method: 'TIME',
          allocationMethod: 'PRO_RATA_BY_VALUE',
          totalAmountCents: -30000,
          reasonCodeId: '00000000-0000-0000-0000-000000000000',
        },
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      allocations: { timeEntryId: string; adjustmentAmountCents: number }[];
    };
    const ids = new Set(body.allocations.map((a) => a.timeEntryId));
    // Only the INCLUDE entry is in the adjustment base.
    expect(ids.has(eInclude)).toBe(true);
    expect(ids.has(eDefer)).toBe(false);
    expect(ids.has(eWriteOff)).toBe(false);
    // The full write-down lands on the INCLUDE entry.
    const total = body.allocations.reduce((s, a) => s + a.adjustmentAmountCents, 0);
    expect(total).toBe(-30000);
  });

  it('CUSTOM_WEIGHTED: percent weights summing to 100 → split by timekeeper', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const u2 = await insertUser(harness.db, seed.firmId, 'c@test.example', 'Cy');
    const batchId = await insertBatch(harness.db, seed.engagementId, seed.appUserId);
    await insertEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      batchId,
      hours: '4.00',
      standardAmountCents: 80000,
    });
    await insertEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: u2,
      workCodeId: seed.workCodeId,
      batchId,
      hours: '2.00',
      standardAmountCents: 40000,
    });

    const router = buildRouter(harness.db);
    const r = await invoke(router, 'post', '/preview', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          billingBatchId: batchId,
          method: 'TIME',
          allocationMethod: 'CUSTOM_WEIGHTED',
          totalAmountCents: -10000,
          reasonCodeId: '00000000-0000-0000-0000-000000000000',
          weightingMode: 'PERCENT',
          weights: [
            { appUserId: seed.appUserId, weight: 75 },
            { appUserId: u2, weight: 25 },
          ],
        },
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      allocations: { appUserId: string; adjustmentAmountCents: number }[];
    };
    const byUser = new Map<string, number>();
    for (const a of body.allocations)
      byUser.set(a.appUserId, (byUser.get(a.appUserId) ?? 0) + a.adjustmentAmountCents);
    expect(byUser.get(seed.appUserId)).toBe(-7500);
    expect(byUser.get(u2)).toBe(-2500);
  });

  it('PARTNER_ABSORBS: surfaces the real detail when no partner-role entries exist', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const batchId = await insertBatch(harness.db, seed.engagementId, seed.appUserId);
    await insertEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      batchId,
      hours: '4.00',
      standardAmountCents: 80000,
    });

    const router = buildRouter(harness.db);
    const r = await invoke(router, 'post', '/preview', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          billingBatchId: batchId,
          method: 'TIME',
          allocationMethod: 'PARTNER_ABSORBS',
          totalAmountCents: -10000,
          reasonCodeId: '00000000-0000-0000-0000-000000000000',
        },
      }),
    });
    expect(r.statusCode).toBe(400);
    const body = r.jsonBody as { error: string; detail: string };
    expect(body.error).toBe('allocation_failed');
    expect(body.detail).toBe('no partner entries available');
  });

  it('PARTNER_ABSORBS: allocates the full amount to partner-role time when present', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await assignRole(harness.db, seed.firmId, seed.appUserId, 'partner');
    const staff = await insertUser(harness.db, seed.firmId, 's@test.example', 'Sam');
    const batchId = await insertBatch(harness.db, seed.engagementId, seed.appUserId);
    await insertEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      batchId,
      hours: '4.00',
      standardAmountCents: 80000,
    });
    await insertEntry(harness.db, {
      engagementId: seed.engagementId,
      appUserId: staff,
      workCodeId: seed.workCodeId,
      batchId,
      hours: '2.00',
      standardAmountCents: 40000,
    });

    const router = buildRouter(harness.db);
    const r = await invoke(router, 'post', '/preview', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          billingBatchId: batchId,
          method: 'TIME',
          allocationMethod: 'PARTNER_ABSORBS',
          totalAmountCents: -10000,
          reasonCodeId: '00000000-0000-0000-0000-000000000000',
        },
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      allocations: { appUserId: string; adjustmentAmountCents: number }[];
    };
    const byUser = new Map<string, number>();
    for (const a of body.allocations)
      byUser.set(a.appUserId, (byUser.get(a.appUserId) ?? 0) + a.adjustmentAmountCents);
    expect(byUser.get(seed.appUserId)).toBe(-10000); // partner absorbs all
    expect(byUser.get(staff) ?? 0).toBe(0); // staff held harmless
  });
});
