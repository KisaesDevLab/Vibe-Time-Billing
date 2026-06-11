// SPDX-License-Identifier: Elastic-2.0
//
// R5 — Phase 8 auto-split tests. Pglite harness, full fixture, exact/
// under/over scenarios + eligibility miss + boundary date. The
// in-process race test against PGlite is documented but skipped
// (PGlite is single-process; row-locking semantics differ from real
// Postgres). Re-enable against Testcontainers when CI permits.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { applyTimeEntryToRetainer } from '../retainers/consumption';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function setupRetainerFixture(opts?: {
  hoursPurchased?: number;
  hoursConsumed?: number;
  status?: 'active' | 'exhausted' | 'expired';
  expiryDate?: string;
}): Promise<{
  firmId: string;
  engagementId: string;
  workCodeId: string;
  retainerId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const { firmId, clientId, engagementId, workCodeId } = seed;
  const tcRes = await harness.db.execute(
    sql`INSERT INTO retainer_tier_config
          (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps)
        VALUES (${firmId}, '1040', 'TIER_1', 'Standard', 10, 25000, 1000)
        RETURNING id`,
  );
  const tcId = (tcRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const invRes = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, invoice_number, issue_date, due_date,
                             subtotal_cents, total_cents)
        VALUES (${firmId}, ${clientId}, 'INV-001', '2026-01-01', '2026-02-01', 0, 0)
        RETURNING id`,
  );
  const invId = (invRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const offRes = await harness.db.execute(
    sql`INSERT INTO retainer_offer
          (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
           prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
           tier_1_price_cents, tier_2_price_cents, offer_expires_at)
        VALUES (${firmId}, ${clientId}, ${engagementId}, ${invId}, '1040', 2025,
                100000, ${tcId}, ${tcId}, 25000, 50000, now() + interval '60 days')
        RETURNING id`,
  );
  const offId = (offRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const retRes = await harness.db.execute(
    sql`INSERT INTO retainer
          (firm_id, client_id, engagement_id, offer_id, purchase_invoice_id,
           tier, return_type, tax_year, tier_config_id, name,
           hours_purchased, hours_consumed, price_cents, purchase_date, expiry_date,
           status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, ${offId}, ${invId},
                'TIER_1', '1040', 2025, ${tcId}, 'Standard',
                ${opts?.hoursPurchased ?? 10}, ${opts?.hoursConsumed ?? 0}, 25000,
                '2026-01-01', ${opts?.expiryDate ?? '2029-04-15'},
                ${opts?.status ?? 'active'})
        RETURNING id`,
  );
  const retainerId = (retRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO retainer_eligible_service (retainer_id, work_code_id) VALUES (${retainerId}, ${workCodeId})`,
  );
  await harness.db.execute(
    sql`UPDATE engagement SET retainer_id = ${retainerId} WHERE id = ${engagementId}`,
  );
  return { firmId, engagementId, workCodeId, retainerId };
}

describe('applyTimeEntryToRetainer (R5 / Phase 8 / D1)', () => {
  it('under: 2h entry on a 10h retainer → 2h applied, 0h spillover', async () => {
    const f = await setupRetainerFixture();
    const r = await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2026-05-01',
        hours: 2,
        workCodeId: f.workCodeId,
      }),
    );
    expect(r.retainerId).toBe(f.retainerId);
    expect(r.retainerHours).toBe(2);
    expect(r.billableHours).toBe(0);
    expect(r.exhausted).toBe(false);
  });

  it('exact: 10h entry on a fresh 10h retainer → 10h applied, exhausted', async () => {
    const f = await setupRetainerFixture();
    const r = await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2026-05-01',
        hours: 10,
        workCodeId: f.workCodeId,
      }),
    );
    expect(r.retainerHours).toBe(10);
    expect(r.billableHours).toBe(0);
    expect(r.exhausted).toBe(true);
    // Retainer flipped to exhausted in the DB
    const rows = await harness.db.execute(
      sql`SELECT status FROM retainer WHERE id = ${f.retainerId}`,
    );
    expect((rows as unknown as { rows: { status: string }[] }).rows[0]!.status).toBe('exhausted');
  });

  it('over: 12h entry on a 10h retainer → 10h applied, 2h spillover, exhausted', async () => {
    const f = await setupRetainerFixture();
    const r = await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2026-05-01',
        hours: 12,
        workCodeId: f.workCodeId,
      }),
    );
    expect(r.retainerHours).toBe(10);
    expect(r.billableHours).toBe(2);
    expect(r.exhausted).toBe(true);
  });

  it('exhausted retainer routes 100% to WIP', async () => {
    const f = await setupRetainerFixture({
      hoursPurchased: 10,
      hoursConsumed: 10,
      status: 'exhausted',
    });
    const r = await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2026-05-01',
        hours: 3,
        workCodeId: f.workCodeId,
      }),
    );
    expect(r.retainerId).toBeNull();
    expect(r.billableHours).toBe(3);
    expect(r.reason).toBe('inactive');
  });

  it('ineligible work code routes 100% to WIP', async () => {
    const f = await setupRetainerFixture();
    // Create an extra work code NOT in eligibility set.
    const wcRes = await harness.db.execute(
      sql`INSERT INTO work_code (firm_id, key, name, service_line_id)
          SELECT firm_id, 'bookkeeping', 'Bookkeeping', service_line_id
          FROM work_code WHERE id = ${f.workCodeId}
          RETURNING id`,
    );
    const otherWcId = (wcRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const r = await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2026-05-01',
        hours: 3,
        workCodeId: otherWcId,
      }),
    );
    expect(r.retainerId).toBeNull();
    expect(r.reason).toBe('wrong_code');
  });

  it('entry on exact expiry_date is eligible (D22)', async () => {
    const f = await setupRetainerFixture({ expiryDate: '2027-04-15' });
    const r = await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2027-04-15',
        hours: 2,
        workCodeId: f.workCodeId,
      }),
    );
    expect(r.retainerHours).toBe(2);
    expect(r.reason).toBeNull();
  });

  it('entry day after expiry routes to WIP', async () => {
    const f = await setupRetainerFixture({ expiryDate: '2027-04-15' });
    const r = await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2027-04-16',
        hours: 2,
        workCodeId: f.workCodeId,
      }),
    );
    expect(r.retainerId).toBeNull();
    expect(r.reason).toBe('expired');
  });

  it('engagement without a retainer routes to WIP', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: seed.engagementId,
        entryDate: '2026-05-01',
        hours: 2,
        workCodeId: seed.workCodeId,
      }),
    );
    expect(r.retainerId).toBeNull();
    expect(r.reason).toBe('no_retainer');
  });

  it('writes ledger row with correct delta + balance', async () => {
    const f = await setupRetainerFixture();
    const userRes = await harness.db.execute(sql`SELECT id FROM app_user LIMIT 1`);
    const userId = (userRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const teRes = await harness.db.execute(
      sql`INSERT INTO time_entry (engagement_id, app_user_id, entry_date, hours,
                                  standard_rate_snapshot_cents, standard_amount_cents)
          VALUES (${f.engagementId}, ${userId}, '2026-05-01', 2.5, 15000, 37500)
          RETURNING id`,
    );
    const timeEntryId = (teRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const r = await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2026-05-01',
        hours: 2.5,
        workCodeId: f.workCodeId,
        timeEntryId,
      }),
    );
    expect(r.retainerHours).toBe(2.5);
    const ledger = await harness.db.execute(
      sql`SELECT kind, hours_delta::text AS d, hours_balance_after::text AS bal
          FROM retainer_ledger WHERE retainer_id = ${f.retainerId} AND kind = 'CONSUME'`,
    );
    const rows = (ledger as unknown as { rows: { kind: string; d: string; bal: string }[] }).rows;
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.d)).toBe(2.5);
    expect(Number(rows[0]!.bal)).toBe(7.5);
  });

  // Race-safety test marked .skip — PGlite is single-process and its
  // row-lock semantics don't match real Postgres. Run against
  // Testcontainers in CI when available.
  it.skip('race: two concurrent inserts against the same retainer serialize', async () => {
    // Reserved for Testcontainers run.
  });
});
