// SPDX-License-Identifier: Elastic-2.0
//
// R5-followup — edit + delete ledger reversal coverage.
//
// Exercises the two helpers directly through the pglite harness so the
// audit-free path is testable without spinning up Express. The HTTP
// integration is covered by existing routes — this proves the inner
// math + ledger writes are correct.
//
// Cases:
//   • Reverse a CONSUME (4h) — hours_consumed drops, REVERSE ledger row
//     written with negative delta + correct balance.
//   • Reverse fully exhausts → un-exhaust: status='exhausted' flips back
//     to 'active' when newConsumed < hours_purchased.
//   • Reverse a zero-hours entry is a no-op (no ledger row).
//   • Reapply after work-code change → first CONSUME backs out via
//     REVERSE, second CONSUME doesn't fire because new work code is
//     ineligible; entry now WIP-only.
//   • Reapply with same work code but smaller hours — REVERSE + smaller
//     CONSUME nets to consuming less than before.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  applyTimeEntryToRetainer,
  reverseTimeEntryConsumption,
  reapplyTimeEntryToRetainer,
} from '../retainers/consumption';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function setupActiveRetainer(opts?: { hoursPurchased?: number }): Promise<{
  retainerId: string;
  engagementId: string;
  workCodeId: string;
  otherWorkCodeId: string;
  appUserId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const tcRes = await harness.db.execute(
    sql`INSERT INTO retainer_tier_config
          (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps)
        VALUES (${seed.firmId}, '1040', 'TIER_1', 'Standard', 10, 25000, 1000)
        RETURNING id`,
  );
  const tierConfigId = (tcRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const hoursPurchased = opts?.hoursPurchased ?? 10;
  const r = await harness.db.execute(
    sql`INSERT INTO retainer
          (firm_id, client_id, engagement_id, tier, return_type, tax_year,
           tier_config_id, name, hours_purchased, hours_consumed, price_cents,
           purchase_date, expiry_date, status)
        VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, 'TIER_1', '1040', 2026,
                ${tierConfigId}, 'Standard', ${hoursPurchased}, 0, 25000,
                '2026-05-24', '2029-05-24', 'active')
        RETURNING id`,
  );
  const retainerId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO retainer_eligible_service (retainer_id, work_code_id)
        VALUES (${retainerId}, ${seed.workCodeId})`,
  );
  await harness.db.execute(
    sql`UPDATE engagement SET retainer_id = ${retainerId} WHERE id = ${seed.engagementId}`,
  );
  // Add a SECOND work code that is NOT eligible — used in the reapply test.
  const otherWc = await harness.db.execute(
    sql`INSERT INTO work_code (firm_id, key, name, service_line_id)
        VALUES (${seed.firmId}, 'admin', 'Admin', ${seed.serviceLineId})
        RETURNING id`,
  );
  const otherWorkCodeId = (otherWc as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return {
    retainerId,
    engagementId: seed.engagementId,
    workCodeId: seed.workCodeId,
    otherWorkCodeId,
    appUserId: seed.appUserId,
  };
}

async function insertTimeEntry(
  engagementId: string,
  appUserId: string,
  workCodeId: string,
  hours: number,
): Promise<string> {
  const res = await harness.db.execute(
    sql`INSERT INTO time_entry (engagement_id, app_user_id, entry_date, hours,
                                 standard_rate_snapshot_cents, standard_amount_cents, work_code_id)
        VALUES (${engagementId}, ${appUserId}, '2027-01-15', ${hours}, 15000, ${15000 * hours}, ${workCodeId})
        RETURNING id`,
  );
  return (res as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

describe('reverseTimeEntryConsumption', () => {
  it('backs hours out and writes a REVERSE ledger row', async () => {
    const f = await setupActiveRetainer();
    const teId = await insertTimeEntry(f.engagementId, f.appUserId, f.workCodeId, 4);
    await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2027-01-15',
        hours: 4,
        workCodeId: f.workCodeId,
        actorAppUserId: f.appUserId,
        timeEntryId: teId,
      }),
    );
    // Sanity — consumption hit.
    const before = await harness.db.execute(
      sql`SELECT hours_consumed::text AS hc FROM retainer WHERE id = ${f.retainerId}`,
    );
    expect(Number((before as unknown as { rows: { hc: string }[] }).rows[0]!.hc)).toBe(4);

    // Reverse it.
    const result = await harness.db.transaction(async (tx) =>
      reverseTimeEntryConsumption(tx, {
        retainerId: f.retainerId,
        retainerHours: 4,
        timeEntryId: teId,
        actorAppUserId: f.appUserId,
      }),
    );
    expect(result.newConsumed).toBe(0);
    expect(result.newStatus).toBe('active');

    const after = await harness.db.execute(
      sql`SELECT hours_consumed::text AS hc, status FROM retainer WHERE id = ${f.retainerId}`,
    );
    const row = (after as unknown as { rows: { hc: string; status: string }[] }).rows[0]!;
    expect(Number(row.hc)).toBe(0);
    expect(row.status).toBe('active');

    const ledger = await harness.db.execute(
      sql`SELECT kind, hours_delta::text AS d, hours_balance_after::text AS b
          FROM retainer_ledger WHERE retainer_id = ${f.retainerId} ORDER BY created_at ASC`,
    );
    const rows = (ledger as unknown as { rows: { kind: string; d: string; b: string }[] }).rows;
    expect(rows.length).toBe(2);
    expect(rows[0]!.kind).toBe('CONSUME');
    expect(Number(rows[0]!.d)).toBe(4);
    expect(rows[1]!.kind).toBe('REVERSE');
    expect(Number(rows[1]!.d)).toBe(-4);
    expect(Number(rows[1]!.b)).toBe(10);
  });

  it('flips exhausted → active when reversal drops below purchased', async () => {
    const f = await setupActiveRetainer({ hoursPurchased: 4 });
    const teId = await insertTimeEntry(f.engagementId, f.appUserId, f.workCodeId, 4);
    await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2027-01-15',
        hours: 4,
        workCodeId: f.workCodeId,
        timeEntryId: teId,
      }),
    );
    // Exhausted after consuming all 4 of 4.
    const exhausted = await harness.db.execute(
      sql`SELECT status FROM retainer WHERE id = ${f.retainerId}`,
    );
    expect((exhausted as unknown as { rows: { status: string }[] }).rows[0]!.status).toBe(
      'exhausted',
    );

    const r = await harness.db.transaction(async (tx) =>
      reverseTimeEntryConsumption(tx, {
        retainerId: f.retainerId,
        retainerHours: 4,
        timeEntryId: teId,
      }),
    );
    expect(r.newStatus).toBe('active');
  });

  it('zero-hours reversal is a no-op (no ledger row)', async () => {
    const f = await setupActiveRetainer();
    const teId = await insertTimeEntry(f.engagementId, f.appUserId, f.workCodeId, 2);
    await harness.db.transaction(async (tx) =>
      reverseTimeEntryConsumption(tx, {
        retainerId: f.retainerId,
        retainerHours: 0,
        timeEntryId: teId,
      }),
    );
    const ledger = await harness.db.execute(
      sql`SELECT count(*)::int AS c FROM retainer_ledger WHERE retainer_id = ${f.retainerId}`,
    );
    expect((ledger as unknown as { rows: { c: number }[] }).rows[0]!.c).toBe(0);
  });
});

describe('reapplyTimeEntryToRetainer (edit path)', () => {
  it('work-code change to ineligible code reverses retainer and routes to WIP', async () => {
    const f = await setupActiveRetainer();
    const teId = await insertTimeEntry(f.engagementId, f.appUserId, f.workCodeId, 3);
    // Original consumption.
    await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2027-01-15',
        hours: 3,
        workCodeId: f.workCodeId,
        timeEntryId: teId,
      }),
    );
    // Edit: switch to ineligible work code.
    const result = await harness.db.transaction(async (tx) =>
      reapplyTimeEntryToRetainer(tx, {
        timeEntryId: teId,
        engagementId: f.engagementId,
        priorRetainerId: f.retainerId,
        priorRetainerHours: 3,
        entryDate: '2027-01-15',
        hours: 3,
        workCodeId: f.otherWorkCodeId,
      }),
    );
    expect(result.retainerId).toBeNull();
    expect(result.billableHours).toBe(3);
    expect(result.reason).toBe('wrong_code');
    const after = await harness.db.execute(
      sql`SELECT hours_consumed::text AS hc FROM retainer WHERE id = ${f.retainerId}`,
    );
    // Reversed 3, applied 0 → balance restored.
    expect(Number((after as unknown as { rows: { hc: string }[] }).rows[0]!.hc)).toBe(0);
  });

  it('hours decrease nets to lower consumption', async () => {
    const f = await setupActiveRetainer();
    const teId = await insertTimeEntry(f.engagementId, f.appUserId, f.workCodeId, 5);
    await harness.db.transaction(async (tx) =>
      applyTimeEntryToRetainer(tx, {
        engagementId: f.engagementId,
        entryDate: '2027-01-15',
        hours: 5,
        workCodeId: f.workCodeId,
        timeEntryId: teId,
      }),
    );
    // Edit: 5h → 2h (still eligible, just smaller).
    const result = await harness.db.transaction(async (tx) =>
      reapplyTimeEntryToRetainer(tx, {
        timeEntryId: teId,
        engagementId: f.engagementId,
        priorRetainerId: f.retainerId,
        priorRetainerHours: 5,
        entryDate: '2027-01-15',
        hours: 2,
        workCodeId: f.workCodeId,
      }),
    );
    expect(result.retainerId).toBe(f.retainerId);
    expect(result.retainerHours).toBe(2);
    expect(result.billableHours).toBe(0);
    const after = await harness.db.execute(
      sql`SELECT hours_consumed::text AS hc FROM retainer WHERE id = ${f.retainerId}`,
    );
    expect(Number((after as unknown as { rows: { hc: string }[] }).rows[0]!.hc)).toBe(2);
  });
});
