// SPDX-License-Identifier: Elastic-2.0
//
// Engagement close-out true-up (realization-only). Verifies: pulls + claims
// accumulated WIP, derives the target (explicit or summed RECURRING_FEE
// lines), creates one allocated FEE adjustment per timekeeper, issues no
// invoice, and routes large deltas through the approval gate.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { type Router } from 'express';
import { sql, eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  adjustments,
  adjustmentAllocations,
  approvalRequests,
  billingBatches,
  invoices,
  timeEntries,
} from '@vibe/db/schema';
import type { Database } from '@vibe/db';

import { createAdjustmentRouter } from '../adjustments/routes';
import { createInvoiceRouter } from '../invoices/routes';
import { createApprovalRouter } from '../approvals/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

function rows<T = { id: string }>(r: unknown): T[] {
  return (r as { rows: T[] }).rows;
}

async function addWip(
  appUserId: string,
  amountCents: number,
  date = '2026-03-15',
): Promise<string> {
  const te = await harness.db.execute(sql`
    INSERT INTO time_entry (engagement_id, app_user_id, work_code_id, entry_date, hours,
      standard_rate_snapshot_cents, standard_amount_cents)
    VALUES (${seed.engagementId}, ${appUserId}, ${seed.workCodeId}, ${date}, 1.0,
      ${amountCents}, ${amountCents})
    RETURNING id`);
  return rows(te)[0]!.id;
}

async function secondUser(): Promise<string> {
  const u = await harness.db.execute(sql`
    INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
    VALUES (${seed.firmId}, 'second@test.example', 'Sec Ond', 'Sec', 'Ond') RETURNING id`);
  return rows(u)[0]!.id;
}

async function seedReason(): Promise<string> {
  const rc = await harness.db.execute(sql`
    INSERT INTO reason_code (firm_id, category, label)
    VALUES (${seed.firmId}, 'WRITE_DOWN', 'Close-out') RETURNING id`);
  return rows(rc)[0]!.id;
}

async function addRecurringInvoiceLine(amountCents: number): Promise<void> {
  const inv = await harness.db.execute(sql`
    INSERT INTO invoice (firm_id, client_id, invoice_number, issue_date, due_date,
      subtotal_cents, total_cents, status)
    VALUES (${seed.firmId}, ${seed.clientId}, 'INV-REC-1', '2026-02-01', '2026-02-15',
      ${amountCents}, ${amountCents}, 'SENT') RETURNING id`);
  const invId = rows(inv)[0]!.id;
  await harness.db.execute(sql`
    INSERT INTO invoice_line_item (invoice_id, kind, description, amount_cents, engagement_id)
    VALUES (${invId}, 'RECURRING_FEE', 'Monthly retainer', ${amountCents}, ${seed.engagementId})`);
}

// --- direct-invoke the final route handler (bypasses step-up + RBAC) ---
interface FakeRes {
  statusCode: number;
  jsonBody: Record<string, unknown>;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: {},
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b as Record<string, unknown>;
      return this;
    },
  };
}
async function invokeLast(
  router: Router,
  method: 'post',
  path: string,
  body: unknown,
  params: Record<string, string> = {},
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
  const req = {
    body,
    params,
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

function buildRouter() {
  return createAdjustmentRouter({
    db: harness.db as Database,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    requireStepUp: (_req: unknown, _res: unknown, next: () => void) => next(),
  });
}

describe('engagement close-out true-up', () => {
  it('writes WIP down to an explicit target, spread per timekeeper, no invoice', async () => {
    const userB = await secondUser();
    await addWip(seed.appUserId, 60000); // $600
    await addWip(userB, 40000); // $400  → WIP standard = $1000
    const reasonId = await seedReason();

    const res = await invokeLast(buildRouter(), 'post', '/close-out-trueup', {
      engagementId: seed.engagementId,
      reasonCodeId: reasonId,
      targetAmountCents: 80000, // realized = $800
      allocationMethod: 'PRO_RATA_BY_VALUE',
    });

    expect(res.statusCode).toBe(201);
    expect(res.jsonBody['deltaCents']).toBe(-20000);
    expect(res.jsonBody['direction']).toBe('WRITE_DOWN');
    expect(res.jsonBody['requiresApproval']).toBe(false);
    expect(res.jsonBody['entriesClaimed']).toBe(2);
    expect(res.jsonBody['invoiced']).toBe(false);

    // One APPLIED FEE adjustment.
    const adj = await harness.db.select().from(adjustments);
    expect(adj).toHaveLength(1);
    expect(adj[0]!.method).toBe('FEE');
    expect(adj[0]!.status).toBe('APPLIED');
    expect(Number(adj[0]!.totalAmountCents)).toBe(-20000);

    // Per-timekeeper allocations sum to the delta; pro-rata 60/40.
    const alloc = await harness.db.select().from(adjustmentAllocations);
    expect(alloc).toHaveLength(2);
    const byUser = new Map(alloc.map((a) => [a.appUserId, Number(a.adjustmentAmountCents)]));
    expect(byUser.get(seed.appUserId)).toBe(-12000);
    expect(byUser.get(userB)).toBe(-8000);
    expect(alloc.reduce((s, a) => s + Number(a.adjustmentAmountCents), 0)).toBe(-20000);

    // WIP claimed; batch is realization-only; no invoice.
    const te = await harness.db.select().from(timeEntries);
    expect(te.every((e) => e.billingBatchId !== null)).toBe(true);
    const [batch] = await harness.db.select().from(billingBatches);
    expect(batch!.status).toBe('APPROVED');
    expect(batch!.invoiceDescription).toContain('realization only');
    expect(await harness.db.select().from(invoices)).toHaveLength(0);
  });

  it('derives the target by summing already-billed RECURRING_FEE lines', async () => {
    await addWip(seed.appUserId, 100000); // $1000 WIP
    await addRecurringInvoiceLine(70000); // billed $700 via recurring
    const reasonId = await seedReason();

    const res = await invokeLast(buildRouter(), 'post', '/close-out-trueup', {
      engagementId: seed.engagementId,
      reasonCodeId: reasonId,
      // no targetAmountCents → auto-sum
    });

    expect(res.statusCode).toBe(201);
    expect(res.jsonBody['targetAmountCents']).toBe(70000);
    expect(res.jsonBody['wipStandardCents']).toBe(100000);
    expect(res.jsonBody['deltaCents']).toBe(-30000);
  });

  it('routes a large delta through the approval gate (no realization yet)', async () => {
    await addWip(seed.appUserId, 100000);
    const reasonId = await seedReason();

    // Write-UP to $3000 → delta +200000, over the $1000 default threshold.
    const res = await invokeLast(buildRouter(), 'post', '/close-out-trueup', {
      engagementId: seed.engagementId,
      reasonCodeId: reasonId,
      targetAmountCents: 300000,
      allocationMethod: 'PRO_RATA_BY_VALUE',
    });

    expect(res.statusCode).toBe(201);
    expect(res.jsonBody['deltaCents']).toBe(200000);
    expect(res.jsonBody['requiresApproval']).toBe(true);
    const [adj] = await harness.db.select().from(adjustments);
    expect(adj!.status).toBe('PENDING_APPROVAL');
    // Allocations are materialized up-front but won't count in realization
    // until the adjustment is APPLIED (realization filters status='APPLIED').
    expect(await harness.db.select().from(adjustmentAllocations)).toHaveLength(1);
    const appr = await harness.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.entityId, adj!.id));
    expect(appr).toHaveLength(1);
  });

  it('400s when the engagement has no unbilled WIP', async () => {
    const reasonId = await seedReason();
    const res = await invokeLast(buildRouter(), 'post', '/close-out-trueup', {
      engagementId: seed.engagementId,
      reasonCodeId: reasonId,
      targetAmountCents: 50000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody['error']).toBe('no_unbilled_wip');
  });

  it('refuses a 0 auto-target instead of silently writing down 100% of WIP', async () => {
    await addWip(seed.appUserId, 100000); // WIP but no recurring invoices
    const reasonId = await seedReason();
    const res = await invokeLast(buildRouter(), 'post', '/close-out-trueup', {
      engagementId: seed.engagementId,
      reasonCodeId: reasonId, // no targetAmountCents → auto = 0
    });
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody['error']).toBe('target_unresolved');
    // No batch / claim happened.
    expect(await harness.db.select().from(billingBatches)).toHaveLength(0);
    const te = await harness.db.select().from(timeEntries);
    expect(te.every((e) => e.billingBatchId === null)).toBe(true);
  });

  it('rejects a reason code from another firm', async () => {
    await addWip(seed.appUserId, 100000);
    const res = await invokeLast(buildRouter(), 'post', '/close-out-trueup', {
      engagementId: seed.engagementId,
      reasonCodeId: '00000000-0000-0000-0000-000000000000',
      targetAmountCents: 80000,
    });
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody['error']).toBe('reason_code_not_found');
  });

  it('zero delta still records an APPLIED $0 adjustment and claims the WIP', async () => {
    await addWip(seed.appUserId, 100000);
    const reasonId = await seedReason();
    const res = await invokeLast(buildRouter(), 'post', '/close-out-trueup', {
      engagementId: seed.engagementId,
      reasonCodeId: reasonId,
      targetAmountCents: 100000, // == WIP → delta 0
    });
    expect(res.statusCode).toBe(201);
    expect(res.jsonBody['deltaCents']).toBe(0);
    expect(res.jsonBody['direction']).toBe('NONE');
    const [adj] = await harness.db.select().from(adjustments);
    expect(adj!.status).toBe('APPLIED');
    expect(Number(adj!.totalAmountCents)).toBe(0);
    const alloc = await harness.db.select().from(adjustmentAllocations);
    expect(alloc).toHaveLength(1);
    const te = await harness.db.select().from(timeEntries);
    expect(te.every((e) => e.billingBatchId !== null)).toBe(true);
  });

  it('the realization-only batch is flagged and CANNOT be invoiced', async () => {
    await addWip(seed.appUserId, 100000);
    const reasonId = await seedReason();
    const res = await invokeLast(buildRouter(), 'post', '/close-out-trueup', {
      engagementId: seed.engagementId,
      reasonCodeId: reasonId,
      targetAmountCents: 80000,
    });
    const batchId = res.jsonBody['batchId'] as string;
    const [batch] = await harness.db
      .select()
      .from(billingBatches)
      .where(eq(billingBatches.id, batchId));
    expect(batch!.realizationOnly).toBe(true);

    // generate-from-batch must refuse it (no double-bill).
    const invoiceRouter = createInvoiceRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const gen = await invokeLast(invoiceRouter, 'post', '/generate-from-batch', {
      billingBatchId: batchId,
    });
    expect(gen.statusCode).toBe(409);
    expect(gen.jsonBody['error']).toBe('batch_not_invoiceable');
    // Still no invoice.
    expect(await harness.db.select().from(invoices)).toHaveLength(0);
  });

  it('rejecting an over-threshold close-out releases the WIP and cancels the batch', async () => {
    const teId = await addWip(seed.appUserId, 100000);
    const reasonId = await seedReason();
    // Write-up to $3000 → delta +200000 > $1000 default threshold → PENDING.
    const res = await invokeLast(buildRouter(), 'post', '/close-out-trueup', {
      engagementId: seed.engagementId,
      reasonCodeId: reasonId,
      targetAmountCents: 300000,
    });
    expect(res.jsonBody['requiresApproval']).toBe(true);
    const batchId = res.jsonBody['batchId'] as string;
    const [adj] = await harness.db.select().from(adjustments);
    const [appr] = await harness.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.entityId, adj!.id));

    // Reject via the approvals decide endpoint.
    const approvalRouter = createApprovalRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const dec = await invokeLast(
      approvalRouter,
      'post',
      '/:id/decide',
      { decision: 'REJECTED', comments: 'not this time' },
      { id: appr!.id },
    );
    expect(dec.statusCode).toBe(200);

    // Adjustment rejected, WIP released back to open, batch cancelled.
    const [adjAfter] = await harness.db.select().from(adjustments);
    expect(adjAfter!.status).toBe('REJECTED');
    const [te] = await harness.db.select().from(timeEntries).where(eq(timeEntries.id, teId));
    expect(te!.billingBatchId).toBeNull();
    const [batchAfter] = await harness.db
      .select()
      .from(billingBatches)
      .where(eq(billingBatches.id, batchId));
    expect(batchAfter!.status).toBe('CANCELLED');
  });
});
