// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R6-followup — coverage for the retainer detail composition.
//
// The /:id/detail endpoint is mostly a join — we exercise the inner
// SQL fragments here so a future schema rename surfaces fast. Express
// mounting is covered by the broader smoke tests.

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

async function setupRetainerWithConsumption(): Promise<{
  firmId: string;
  appUserId: string;
  retainerId: string;
  engagementId: string;
  workCodeId: string;
  timeEntryId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const tc = await harness.db.execute(
    sql`INSERT INTO retainer_tier_config
          (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps)
        VALUES (${seed.firmId}, '1040', 'TIER_1', 'Standard', 10, 25000, 1000)
        RETURNING id`,
  );
  const tierConfigId = (tc as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const r = await harness.db.execute(
    sql`INSERT INTO retainer
          (firm_id, client_id, engagement_id, tier, return_type, tax_year,
           tier_config_id, name, hours_purchased, hours_consumed, price_cents,
           purchase_date, expiry_date, status)
        VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, 'TIER_1', '1040', 2026,
                ${tierConfigId}, 'Standard', 10, 0, 25000,
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
  // Activation seed row in ledger.
  await harness.db.execute(
    sql`INSERT INTO retainer_ledger (retainer_id, kind, hours_delta, hours_balance_after)
        VALUES (${retainerId}, 'ACTIVATION', 0, 10)`,
  );
  // Add a time entry + consume.
  const teRes = await harness.db.execute(
    sql`INSERT INTO time_entry (engagement_id, app_user_id, entry_date, hours,
                                 standard_rate_snapshot_cents, standard_amount_cents,
                                 work_code_id, description)
        VALUES (${seed.engagementId}, ${seed.appUserId}, '2027-01-15', 3, 15000, 45000,
                ${seed.workCodeId}, 'Client follow-up call')
        RETURNING id`,
  );
  const teId = (teRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.transaction(async (tx) =>
    applyTimeEntryToRetainer(tx, {
      engagementId: seed.engagementId,
      entryDate: '2027-01-15',
      hours: 3,
      workCodeId: seed.workCodeId,
      timeEntryId: teId,
      actorAppUserId: seed.appUserId,
    }),
  );
  // Audit-log entries — simulate a pause/resume cycle.
  await harness.db.execute(
    sql`INSERT INTO audit_log (action, entity_type, entity_id, actor_app_user_id, after_json)
        VALUES ('UPDATE', 'retainer', ${retainerId}, ${seed.appUserId},
                ${JSON.stringify({ status: 'paused', reason: 'client on hold' })}::jsonb)`,
  );
  await harness.db.execute(
    sql`INSERT INTO audit_log (action, entity_type, entity_id, actor_app_user_id, after_json)
        VALUES ('UPDATE', 'retainer', ${retainerId}, ${seed.appUserId},
                ${JSON.stringify({ status: 'active', resumed: true })}::jsonb)`,
  );
  return {
    firmId: seed.firmId,
    appUserId: seed.appUserId,
    retainerId,
    engagementId: seed.engagementId,
    workCodeId: seed.workCodeId,
    timeEntryId: teId,
  };
}

describe('retainer detail SQL composition', () => {
  it('eligibility join surfaces work codes by name', async () => {
    const f = await setupRetainerWithConsumption();
    const rows = await harness.db.execute(
      sql`SELECT wc.id, wc.key, wc.name
          FROM retainer_eligible_service res
          JOIN work_code wc ON wc.id = res.work_code_id
          WHERE res.retainer_id = ${f.retainerId}
          ORDER BY wc.name`,
    );
    const r = (rows as unknown as { rows: Array<{ id: string; key: string; name: string }> }).rows;
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(f.workCodeId);
    expect(r[0]!.name).toBe('Tax Preparation');
  });

  it('ledger join surfaces time-entry context for CONSUME rows', async () => {
    const f = await setupRetainerWithConsumption();
    const rows = await harness.db.execute(
      sql`SELECT rl.id, rl.kind, rl.hours_delta::text AS hours_delta,
                 rl.hours_balance_after::text AS hours_balance_after,
                 rl.time_entry_id, rl.created_by_id,
                 au.full_name AS actor_name,
                 te.entry_date, te.hours::text AS entry_hours, te.description AS entry_description,
                 wc.name AS work_code_name
          FROM retainer_ledger rl
          LEFT JOIN app_user au ON au.id = rl.created_by_id
          LEFT JOIN time_entry te ON te.id = rl.time_entry_id
          LEFT JOIN work_code wc ON wc.id = te.work_code_id
          WHERE rl.retainer_id = ${f.retainerId}
          ORDER BY rl.created_at ASC`,
    );
    const r =
      (
        rows as unknown as {
          rows: Array<{
            kind: string;
            hours_delta: string;
            time_entry_id: string | null;
            actor_name: string | null;
            entry_description: string | null;
            work_code_name: string | null;
          }>;
        }
      ).rows ?? [];
    expect(r.length).toBe(2);
    // ACTIVATION seed first (no time entry / actor).
    expect(r[0]!.kind).toBe('ACTIVATION');
    expect(r[0]!.time_entry_id).toBeNull();
    // CONSUME has the joined context.
    expect(r[1]!.kind).toBe('CONSUME');
    expect(r[1]!.time_entry_id).toBe(f.timeEntryId);
    expect(r[1]!.actor_name).toBe('Sarah Chen');
    expect(r[1]!.entry_description).toBe('Client follow-up call');
    expect(r[1]!.work_code_name).toBe('Tax Preparation');
  });

  it('timeline join returns retainer audit events in order with actor name', async () => {
    const f = await setupRetainerWithConsumption();
    const rows = await harness.db.execute(
      sql`SELECT al.action, al.after_json, au.full_name AS actor_name
          FROM audit_log al
          LEFT JOIN app_user au ON au.id = al.actor_app_user_id
          WHERE al.entity_type = 'retainer'
            AND al.entity_id = ${f.retainerId}
          ORDER BY al.occurred_at ASC`,
    );
    const r =
      (
        rows as unknown as {
          rows: Array<{
            action: string;
            after_json: { status?: string; reason?: string; resumed?: boolean } | null;
            actor_name: string | null;
          }>;
        }
      ).rows ?? [];
    expect(r).toHaveLength(2);
    expect(r[0]!.after_json?.status).toBe('paused');
    expect(r[0]!.after_json?.reason).toBe('client on hold');
    expect(r[1]!.after_json?.status).toBe('active');
    expect(r[1]!.after_json?.resumed).toBe(true);
    expect(r[0]!.actor_name).toBe('Sarah Chen');
  });
});
