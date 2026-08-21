// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Industry-standard billing realization (CCH/Practice CS/Canopy method):
//   realization = (standard value of ALL billed WIP + net write-up/down)
//               ÷ (standard value of ALL billed WIP)
// Universe = INCLUDE entries of INVOICED batches with a posted invoice
// (plus realization-only close-out batches); periods keyed to the invoice
// issue date. These tests seed a billed batch with an applied write-down
// and assert the rollup, the unadjusted-at-100% base, the unbilled-WIP
// exclusion, multi-adjustment netting, and the relief-date window.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createReportRouter } from '../reports/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

interface FakeReq {
  query: Record<string, string>;
  params: Record<string, string>;
  body: unknown;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  get(_h: string): string | undefined;
}
interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  body: string | undefined;
  headers: Record<string, string>;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  send(b: string): FakeRes;
  setHeader(k: string, v: string): void;
}
function makeReq(firmId: string, appUserId: string, query: Record<string, string>): FakeReq {
  return {
    query,
    params: {},
    body: {},
    staffSession: { firmId, appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}
function makeRes(): FakeRes {
  const r: FakeRes = {
    statusCode: 200,
    jsonBody: undefined,
    body: undefined,
    headers: {},
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
  };
  return r;
}
async function invoke(
  router: ReturnType<typeof createReportRouter>,
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const route = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return route.path === path && route.methods['get'] === true;
  });
  if (!layer) throw new Error(`route not registered: GET ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  // Last handler in the stack is the route handler (permission middleware skipped).
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

function rows<T = { id: string }>(r: unknown): T[] {
  return (r as { rows: T[] }).rows;
}

// Seed one INVOICED billing batch (posted invoice issued 2026-02-01) with a
// single $1,000 INCLUDE time entry and an APPLIED $400 write-down allocated
// to the seeded user. Returns ids so tests can extend the fixture.
async function seedRealization(opts: { issueDate?: string } = {}): Promise<{
  firmId: string;
  appUserId: string;
  clientId: string;
  engagementId: string;
  workCodeId: string;
  batchId: string;
  teId: string;
  reasonId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const issueDate = opts.issueDate ?? '2026-02-01';
  const batch = await harness.db.execute(sql`
    INSERT INTO billing_batch (engagement_id, period_start, period_end, status, created_by_id, approved_by_id)
    VALUES (${seed.engagementId}, '2026-01-01', '2026-01-31', 'INVOICED', ${seed.appUserId}, ${seed.appUserId})
    RETURNING id`);
  const batchId = rows(batch)[0]!.id;
  const te = await harness.db.execute(sql`
    INSERT INTO time_entry (engagement_id, app_user_id, work_code_id, entry_date, hours,
      standard_rate_snapshot_cents, standard_amount_cents, billing_batch_id)
    VALUES (${seed.engagementId}, ${seed.appUserId}, ${seed.workCodeId}, '2026-01-15', 2.0,
      50000, 100000, ${batchId})
    RETURNING id`);
  const teId = rows(te)[0]!.id;
  await harness.db.execute(sql`
    INSERT INTO billing_batch_entry (billing_batch_id, time_entry_id, action)
    VALUES (${batchId}, ${teId}, 'INCLUDE')`);
  // Posted invoice carrying the batch's line (the WIP-relief event).
  const inv = await harness.db.execute(sql`
    INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
      issue_date, due_date, subtotal_cents, total_cents, status)
    VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, 'INV-R1',
      ${issueDate}, ${issueDate}, 60000, 60000, 'SENT')
    RETURNING id`);
  const invId = rows(inv)[0]!.id;
  await harness.db.execute(sql`
    INSERT INTO invoice_line_item (invoice_id, kind, description, amount_cents,
      engagement_id, source_ref_type, source_ref_id)
    VALUES (${invId}, 'TIME_AGGREGATE', 'January services', 60000,
      ${seed.engagementId}, 'billing_batch', ${batchId})`);
  const rc = await harness.db.execute(sql`
    INSERT INTO reason_code (firm_id, category, label)
    VALUES (${seed.firmId}, 'WRITE_DOWN', 'Scope creep') RETURNING id`);
  const reasonId = rows(rc)[0]!.id;
  const adj = await harness.db.execute(sql`
    INSERT INTO adjustment (billing_batch_id, method, allocation_method, total_amount_cents,
      reason_code_id, status, created_by_id)
    VALUES (${batchId}, 'TIME', 'HIERARCHICAL_CASCADE', -40000, ${reasonId}, 'APPLIED', ${seed.appUserId})
    RETURNING id`);
  const adjId = rows(adj)[0]!.id;
  await harness.db.execute(sql`
    INSERT INTO adjustment_allocation (adjustment_id, time_entry_id, app_user_id,
      original_value_cents, adjusted_value_cents, adjustment_amount_cents)
    VALUES (${adjId}, ${teId}, ${seed.appUserId}, 100000, 60000, -40000)`);
  return {
    firmId: seed.firmId,
    appUserId: seed.appUserId,
    clientId: seed.clientId,
    engagementId: seed.engagementId,
    workCodeId: seed.workCodeId,
    batchId,
    teId,
    reasonId,
  };
}

describe('GET /realization', () => {
  it('rolls up the firm summary from allocations joined through adjustments', async () => {
    const { firmId, appUserId } = await seedRealization();
    const router = createReportRouter({ db: harness.db });
    const res = await invoke(router, '/realization', makeReq(firmId, appUserId, {}));
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as {
      dimension: string;
      summary: { originalValueCents: number; adjustedValueCents: number; realizationPct: number };
    };
    expect(body.dimension).toBe('firm');
    // $1,000 original written down to $600 → 60% realization.
    expect(body.summary.originalValueCents).toBe(100000);
    expect(body.summary.adjustedValueCents).toBe(60000);
    expect(body.summary.realizationPct).toBeCloseTo(0.6);
  });

  it('excludes allocations from non-APPLIED (reversed/pending) adjustments', async () => {
    const { firmId, appUserId } = await seedRealization();
    // Reversing an adjustment only flips its status to REVERSED — the
    // allocation rows persist. A second, never-applied (PENDING_APPROVAL)
    // adjustment also writes allocations before approval. Neither should be
    // counted by the report.
    const batchId = rows(await harness.db.execute(sql`SELECT id FROM billing_batch LIMIT 1`))[0]!
      .id;
    const teId = rows(await harness.db.execute(sql`SELECT id FROM time_entry LIMIT 1`))[0]!.id;
    const reasonId = rows(await harness.db.execute(sql`SELECT id FROM reason_code LIMIT 1`))[0]!.id;
    for (const status of ['REVERSED', 'PENDING_APPROVAL']) {
      const adjId = rows(
        await harness.db.execute(sql`
          INSERT INTO adjustment (billing_batch_id, method, allocation_method, total_amount_cents,
            reason_code_id, status, created_by_id)
          VALUES (${batchId}, 'TIME', 'HIERARCHICAL_CASCADE', -90000, ${reasonId}, ${status}, ${appUserId})
          RETURNING id`),
      )[0]!.id;
      await harness.db.execute(sql`
        INSERT INTO adjustment_allocation (adjustment_id, time_entry_id, app_user_id,
          original_value_cents, adjusted_value_cents, adjustment_amount_cents)
        VALUES (${adjId}, ${teId}, ${appUserId}, 100000, 10000, -90000)`);
    }
    const router = createReportRouter({ db: harness.db });
    const res = await invoke(router, '/realization', makeReq(firmId, appUserId, {}));
    const body = res.jsonBody as {
      summary: { originalValueCents: number; adjustedValueCents: number; realizationPct: number };
    };
    // Only the APPLIED write-down counts: still $1,000 → $600 (60%). If the
    // status filter regressed, the extra allocations would drag this down.
    expect(body.summary.originalValueCents).toBe(100000);
    expect(body.summary.adjustedValueCents).toBe(60000);
    expect(body.summary.realizationPct).toBeCloseTo(0.6);
  });

  it('returns per-timekeeper items (non-empty) for the timekeeper dimension', async () => {
    const { firmId, appUserId } = await seedRealization();
    const router = createReportRouter({ db: harness.db });
    const res = await invoke(
      router,
      '/realization',
      makeReq(firmId, appUserId, { dimension: 'timekeeper' }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as {
      items: { key: string; originalValueCents: number; adjustedValueCents: number }[];
    };
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.key).toBe(appUserId);
    expect(body.items[0]!.originalValueCents).toBe(100000);
    expect(body.items[0]!.adjustedValueCents).toBe(60000);
  });

  it('unadjusted billed time enters the base at exactly 100%', async () => {
    const s = await seedRealization();
    // Second INVOICED batch, $500 entry, NO adjustment at all.
    const b2 = rows(
      await harness.db.execute(sql`
        INSERT INTO billing_batch (engagement_id, period_start, period_end, status, created_by_id)
        VALUES (${s.engagementId}, '2026-02-01', '2026-02-28', 'INVOICED', ${s.appUserId})
        RETURNING id`),
    )[0]!.id;
    const te2 = rows(
      await harness.db.execute(sql`
        INSERT INTO time_entry (engagement_id, app_user_id, work_code_id, entry_date, hours,
          standard_rate_snapshot_cents, standard_amount_cents, billing_batch_id)
        VALUES (${s.engagementId}, ${s.appUserId}, ${s.workCodeId}, '2026-02-10', 1.0,
          50000, 50000, ${b2}) RETURNING id`),
    )[0]!.id;
    await harness.db.execute(sql`
      INSERT INTO billing_batch_entry (billing_batch_id, time_entry_id, action)
      VALUES (${b2}, ${te2}, 'INCLUDE')`);
    const inv2 = rows(
      await harness.db.execute(sql`
        INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
          issue_date, due_date, subtotal_cents, total_cents, status)
        VALUES (${s.firmId}, ${s.clientId}, ${s.engagementId}, 'INV-R2',
          '2026-03-01', '2026-03-31', 50000, 50000, 'SENT') RETURNING id`),
    )[0]!.id;
    await harness.db.execute(sql`
      INSERT INTO invoice_line_item (invoice_id, kind, description, amount_cents,
        engagement_id, source_ref_type, source_ref_id)
      VALUES (${inv2}, 'TIME_AGGREGATE', 'February services', 50000,
        ${s.engagementId}, 'billing_batch', ${b2})`);

    const router = createReportRouter({ db: harness.db });
    const res = await invoke(router, '/realization', makeReq(s.firmId, s.appUserId, {}));
    const body = res.jsonBody as {
      summary: { originalValueCents: number; adjustedValueCents: number; realizationPct: number };
    };
    // ($1,000 → $600) + ($500 billed at standard, 100%) = 1500/1100 base.
    expect(body.summary.originalValueCents).toBe(150000);
    expect(body.summary.adjustedValueCents).toBe(110000);
    expect(body.summary.realizationPct).toBeCloseTo(110000 / 150000);
  });

  it('excludes unbilled WIP: adjusted-but-never-invoiced batches do not count', async () => {
    const s = await seedRealization();
    // DRAFT batch with an APPLIED write-down but no invoice — a pre-bill
    // adjustment. Industry timing: nothing hits realization until posted.
    const b2 = rows(
      await harness.db.execute(sql`
        INSERT INTO billing_batch (engagement_id, period_start, period_end, status, created_by_id)
        VALUES (${s.engagementId}, '2026-02-01', '2026-02-28', 'DRAFT', ${s.appUserId})
        RETURNING id`),
    )[0]!.id;
    const te2 = rows(
      await harness.db.execute(sql`
        INSERT INTO time_entry (engagement_id, app_user_id, work_code_id, entry_date, hours,
          standard_rate_snapshot_cents, standard_amount_cents, billing_batch_id)
        VALUES (${s.engagementId}, ${s.appUserId}, ${s.workCodeId}, '2026-02-10', 1.0,
          50000, 50000, ${b2}) RETURNING id`),
    )[0]!.id;
    await harness.db.execute(sql`
      INSERT INTO billing_batch_entry (billing_batch_id, time_entry_id, action)
      VALUES (${b2}, ${te2}, 'INCLUDE')`);
    const adj2 = rows(
      await harness.db.execute(sql`
        INSERT INTO adjustment (billing_batch_id, method, allocation_method, total_amount_cents,
          reason_code_id, status, created_by_id)
        VALUES (${b2}, 'TIME', 'HIERARCHICAL_CASCADE', -25000, ${s.reasonId}, 'APPLIED', ${s.appUserId})
        RETURNING id`),
    )[0]!.id;
    await harness.db.execute(sql`
      INSERT INTO adjustment_allocation (adjustment_id, time_entry_id, app_user_id,
        original_value_cents, adjusted_value_cents, adjustment_amount_cents)
      VALUES (${adj2}, ${te2}, ${s.appUserId}, 50000, 25000, -25000)`);

    const router = createReportRouter({ db: harness.db });
    const res = await invoke(router, '/realization', makeReq(s.firmId, s.appUserId, {}));
    const body = res.jsonBody as {
      summary: { originalValueCents: number; adjustedValueCents: number };
    };
    // Only the invoiced batch counts: still 1000/600.
    expect(body.summary.originalValueCents).toBe(100000);
    expect(body.summary.adjustedValueCents).toBe(60000);
  });

  it('nets multiple adjustments on one batch without double-counting the WIP base', async () => {
    const s = await seedRealization();
    // Second APPLIED write-down on the SAME batch, covering the same entry.
    const adj2 = rows(
      await harness.db.execute(sql`
        INSERT INTO adjustment (billing_batch_id, method, allocation_method, total_amount_cents,
          reason_code_id, status, created_by_id)
        VALUES (${s.batchId}, 'TIME', 'HIERARCHICAL_CASCADE', -10000, ${s.reasonId}, 'APPLIED', ${s.appUserId})
        RETURNING id`),
    )[0]!.id;
    await harness.db.execute(sql`
      INSERT INTO adjustment_allocation (adjustment_id, time_entry_id, app_user_id,
        original_value_cents, adjusted_value_cents, adjustment_amount_cents)
      VALUES (${adj2}, ${s.teId}, ${s.appUserId}, 100000, 90000, -10000)`);

    const router = createReportRouter({ db: harness.db });
    const res = await invoke(router, '/realization', makeReq(s.firmId, s.appUserId, {}));
    const body = res.jsonBody as {
      summary: { originalValueCents: number; adjustedValueCents: number; realizationPct: number };
    };
    // Base counted ONCE ($1,000), deltas net (−400 −100): 500/1000 = 50%.
    // The old allocation-sum method reported 2000/1500 = 75%.
    expect(body.summary.originalValueCents).toBe(100000);
    expect(body.summary.adjustedValueCents).toBe(50000);
    expect(body.summary.realizationPct).toBeCloseTo(0.5);
  });

  it('pro-rates allocation-less (set-target) adjustments into realization', async () => {
    const s = await seedRealization();
    // APPROVED adjustment with NO allocation rows — the set-target path.
    await harness.db.execute(sql`
      INSERT INTO adjustment (billing_batch_id, method, allocation_method, total_amount_cents,
        reason_code_id, status, created_by_id)
      VALUES (${s.batchId}, 'FEE', 'PRO_RATA_BY_VALUE', -20000, ${s.reasonId}, 'APPROVED', ${s.appUserId})`);

    const router = createReportRouter({ db: harness.db });
    const res = await invoke(router, '/realization', makeReq(s.firmId, s.appUserId, {}));
    const body = res.jsonBody as {
      summary: { originalValueCents: number; adjustedValueCents: number };
    };
    // −400 allocated + −200 set-target pro-rated: 1000 → 400.
    expect(body.summary.originalValueCents).toBe(100000);
    expect(body.summary.adjustedValueCents).toBe(40000);
  });

  it('windows by invoice (WIP-relief) date, not work date', async () => {
    const s = await seedRealization({ issueDate: '2026-02-01' });
    const router = createReportRouter({ db: harness.db });
    // Work happened in January, invoice posted 2026-02-01. A February
    // window catches it; a January window (which contains the work date)
    // does not.
    const feb = await invoke(
      router,
      '/realization',
      makeReq(s.firmId, s.appUserId, { start: '2026-02-01', end: '2026-02-28' }),
    );
    const febBody = feb.jsonBody as { summary: { originalValueCents: number } };
    expect(febBody.summary.originalValueCents).toBe(100000);

    const jan = await invoke(
      router,
      '/realization',
      makeReq(s.firmId, s.appUserId, { start: '2026-01-01', end: '2026-01-31' }),
    );
    const janBody = jan.jsonBody as { summary: { originalValueCents: number } };
    expect(janBody.summary.originalValueCents).toBe(0);
  });

  it('a voided invoice un-bills its batch (drops from realization)', async () => {
    const s = await seedRealization();
    await harness.db.execute(
      sql`UPDATE invoice SET status = 'VOIDED' WHERE invoice_number = 'INV-R1'`,
    );
    const router = createReportRouter({ db: harness.db });
    const res = await invoke(router, '/realization', makeReq(s.firmId, s.appUserId, {}));
    const body = res.jsonBody as { summary: { originalValueCents: number } };
    expect(body.summary.originalValueCents).toBe(0);
  });
});

describe('GET /effective-rate', () => {
  it('uses billed (post-write-down) value over billable hours', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // The endpoint windows to the trailing 90 days, so seed a recent entry
    // (relative to now, not a fixed past date) to stay in-window.
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const batchId = rows(
      await harness.db.execute(sql`
        INSERT INTO billing_batch (engagement_id, period_start, period_end, status, created_by_id, approved_by_id)
        VALUES (${seed.engagementId}, ${recent}, ${recent}, 'APPROVED', ${seed.appUserId}, ${seed.appUserId})
        RETURNING id`),
    )[0]!.id;
    const teId = rows(
      await harness.db.execute(sql`
        INSERT INTO time_entry (engagement_id, app_user_id, work_code_id, entry_date, hours,
          standard_rate_snapshot_cents, standard_amount_cents, billing_batch_id)
        VALUES (${seed.engagementId}, ${seed.appUserId}, ${seed.workCodeId}, ${recent}, 2.0,
          50000, 100000, ${batchId})
        RETURNING id`),
    )[0]!.id;
    const reasonId = rows(
      await harness.db.execute(sql`
        INSERT INTO reason_code (firm_id, category, label)
        VALUES (${seed.firmId}, 'WRITE_DOWN', 'Scope creep') RETURNING id`),
    )[0]!.id;
    const adjId = rows(
      await harness.db.execute(sql`
        INSERT INTO adjustment (billing_batch_id, method, allocation_method, total_amount_cents,
          reason_code_id, status, created_by_id)
        VALUES (${batchId}, 'TIME', 'HIERARCHICAL_CASCADE', -40000, ${reasonId}, 'APPLIED', ${seed.appUserId})
        RETURNING id`),
    )[0]!.id;
    await harness.db.execute(sql`
      INSERT INTO adjustment_allocation (adjustment_id, time_entry_id, app_user_id,
        original_value_cents, adjusted_value_cents, adjustment_amount_cents)
      VALUES (${adjId}, ${teId}, ${seed.appUserId}, 100000, 60000, -40000)`);

    const router = createReportRouter({ db: harness.db });
    const res = await invoke(router, '/effective-rate', makeReq(seed.firmId, seed.appUserId, {}));
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as {
      items: Array<{
        appUserId: string;
        hours: number;
        amountCents: number;
        effectiveRateCents: number | null;
      }>;
    };
    const row = body.items.find((i) => i.appUserId === seed.appUserId)!;
    // $1,000 standard written down (APPLIED) to $600, over 2 billable hours:
    // billed $600 / 2h = $300/h. The old bug used standard $1,000 → $500/h.
    expect(row.hours).toBe(2);
    expect(row.amountCents).toBe(60000);
    expect(row.effectiveRateCents).toBe(30000);
  });
});

// 0223 — billing realization report: same universe as /realization, laid
// out as the classic practice-management columns with a totals row. The
// two endpoints must never disagree on amount / fee / real %.
describe('GET /billing-realization', () => {
  it('matches /realization and derives hours, adjustment, and rates', async () => {
    const { firmId, appUserId } = await seedRealization();
    const router = createReportRouter({ db: harness.db });
    const res = await invoke(
      router,
      '/billing-realization',
      makeReq(firmId, appUserId, { dimension: 'timekeeper' }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as {
      dimension: string;
      rows: {
        key: string;
        code: string;
        hours: number;
        originalValueCents: number;
        adjustmentCents: number;
        adjustedValueCents: number;
        chargeRateCents: number;
        feeRateCents: number;
        realizationPct: number;
      }[];
      totals: { hours: number; adjustedValueCents: number; realizationPct: number };
    };
    expect(body.dimension).toBe('timekeeper');
    expect(body.rows).toHaveLength(1);
    const r = body.rows[0]!;
    expect(r.key).toBe(appUserId);
    // $1,000 standard → $600 fee over 2 hours.
    expect(r.originalValueCents).toBe(100000);
    expect(r.adjustmentCents).toBe(-40000);
    expect(r.adjustedValueCents).toBe(60000);
    expect(r.hours).toBe(2);
    expect(r.chargeRateCents).toBe(50000);
    expect(r.feeRateCents).toBe(30000);
    expect(r.realizationPct).toBeCloseTo(0.6);
    expect(body.totals.hours).toBe(2);
    expect(body.totals.adjustedValueCents).toBe(60000);
    expect(body.totals.realizationPct).toBeCloseTo(0.6);
  });

  it('supports the engagement_type dimension (unassigned bucket when no type)', async () => {
    const { firmId, appUserId } = await seedRealization();
    const router = createReportRouter({ db: harness.db });
    const res = await invoke(
      router,
      '/billing-realization',
      makeReq(firmId, appUserId, { dimension: 'engagement_type' }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as { rows: { key: string; adjustedValueCents: number }[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.adjustedValueCents).toBe(60000);
  });

  it('csv export includes the Report Totals line', async () => {
    const { firmId, appUserId } = await seedRealization();
    const router = createReportRouter({ db: harness.db });
    const res = await invoke(
      router,
      '/billing-realization',
      makeReq(firmId, appUserId, { dimension: 'timekeeper', format: 'csv' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      'id,name,hours,amount,adjusted,fee_amt,charge_rate,fee_rate,real_pct',
    );
    expect(res.body).toContain('Report Totals');
    expect(res.body).toContain('2.00,1000.00,-400.00,600.00,500.00,300.00,60.00');
  });
});

describe('GET /billing-realization — client-attribute dimensions', () => {
  it('firm_owner, location, entity_type, client_zip each preserve the total', async () => {
    const { firmId, appUserId } = await seedRealization();
    const router = createReportRouter({ db: harness.db });
    for (const dimension of ['firm_owner', 'location', 'entity_type', 'client_zip'] as const) {
      const res = await invoke(
        router,
        '/billing-realization',
        makeReq(firmId, appUserId, { dimension }),
      );
      expect(res.statusCode).toBe(200);
      const body = res.jsonBody as {
        dimension: string;
        rows: { adjustedValueCents: number }[];
        totals: { adjustedValueCents: number };
      };
      expect(body.dimension).toBe(dimension);
      const sum = body.rows.reduce((s, r) => s + r.adjustedValueCents, 0);
      expect(sum).toBe(60000);
      expect(body.totals.adjustedValueCents).toBe(60000);
    }
  });
});
