// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R6-followup — /my/retainers visibility filter.
//
// Exercises the SQL filter from retainers/routes.ts ('mine' endpoint).
// The scope must include retainers on engagements where the user is:
//   1. engagement.partner_id, OR
//   2. engagement.manager_id, OR
//   3. has an engagement_assignment row.
// Retainers on engagements the user has NO relationship with must be
// excluded.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

interface ScopeSetup {
  firmId: string;
  meUserId: string;
  otherUserId: string;
  retainerAssignedToMe: string;
  retainerPartnerInChargeMe: string;
  retainerManagerMe: string;
  retainerForOther: string;
}

async function setupScopeFixture(): Promise<ScopeSetup> {
  const seed = await seedMinimalFirm(harness.db);
  const meUserId = seed.appUserId;
  // Add a second user with no relationship to any engagement we'll
  // create — used to confirm scope filters out unrelated retainers.
  const otherUser = await harness.db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
        VALUES (${seed.firmId}, 'other@test.example', 'Other Person', 'Other', 'Person')
        RETURNING id`,
  );
  const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;

  // Tier config used by every retainer below.
  const tc = await harness.db.execute(
    sql`INSERT INTO retainer_tier_config
          (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps)
        VALUES (${seed.firmId}, '1040', 'TIER_1', 'Standard', 10, 25000, 1000)
        RETURNING id`,
  );
  const tierConfigId = (tc as unknown as { rows: { id: string }[] }).rows[0]!.id;

  async function makeEngagement(
    label: string,
    opts: { partnerId?: string; managerId?: string; assignToMe?: boolean },
  ): Promise<{ engagementId: string; clientId: string }> {
    const client = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id)
          VALUES (${seed.firmId}, ${label + ' Co'}, ${seed.appUserId}) RETURNING id`,
    );
    const clientId = (client as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const eng = await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure, partner_id, manager_id)
          VALUES (${clientId}, ${label}, 'HOURLY', ${opts.partnerId ?? null}, ${opts.managerId ?? null})
          RETURNING id`,
    );
    const engagementId = (eng as unknown as { rows: { id: string }[] }).rows[0]!.id;
    if (opts.assignToMe) {
      await harness.db.execute(
        sql`INSERT INTO engagement_assignment (engagement_id, app_user_id, role)
            VALUES (${engagementId}, ${meUserId}, 'STAFF')`,
      );
    }
    return { engagementId, clientId };
  }

  async function makeRetainer(engagementId: string, clientId: string): Promise<string> {
    const r = await harness.db.execute(
      sql`INSERT INTO retainer
            (firm_id, client_id, engagement_id, tier, return_type, tax_year,
             tier_config_id, name, hours_purchased, hours_consumed, price_cents,
             purchase_date, expiry_date, status)
          VALUES (${seed.firmId}, ${clientId}, ${engagementId}, 'TIER_1', '1040', 2026,
                  ${tierConfigId}, 'Std', 10, 0, 25000,
                  '2026-05-24', '2029-05-24', 'active')
          RETURNING id`,
    );
    return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
  }

  const a = await makeEngagement('Assigned', { assignToMe: true });
  const p = await makeEngagement('PartnerMe', { partnerId: meUserId });
  const m = await makeEngagement('ManagerMe', { managerId: meUserId });
  const o = await makeEngagement('SomeoneElse', {
    partnerId: otherUserId,
    managerId: otherUserId,
  });

  return {
    firmId: seed.firmId,
    meUserId,
    otherUserId,
    retainerAssignedToMe: await makeRetainer(a.engagementId, a.clientId),
    retainerPartnerInChargeMe: await makeRetainer(p.engagementId, p.clientId),
    retainerManagerMe: await makeRetainer(m.engagementId, m.clientId),
    retainerForOther: await makeRetainer(o.engagementId, o.clientId),
  };
}

// The SQL from retainers/routes.ts /mine. Inlined here for the test so
// we exercise the exact query the route uses without booting Express.
async function listMineIds(firmId: string, userId: string): Promise<string[]> {
  const rows = await harness.db.execute(
    sql`SELECT r.id FROM retainer r
        WHERE r.firm_id = ${firmId}
          AND r.engagement_id IN (
            SELECT e.id FROM engagement e
            WHERE e.partner_id = ${userId}
               OR e.manager_id = ${userId}
            UNION
            SELECT ea.engagement_id FROM engagement_assignment ea
            WHERE ea.app_user_id = ${userId}
          )
        ORDER BY r.created_at`,
  );
  return ((rows as unknown as { rows: { id: string }[] }).rows ?? []).map((r) => r.id);
}

describe('/my/retainers scope filter', () => {
  it('includes assigned + partner + manager retainers', async () => {
    const f = await setupScopeFixture();
    const ids = await listMineIds(f.firmId, f.meUserId);
    expect(ids).toContain(f.retainerAssignedToMe);
    expect(ids).toContain(f.retainerPartnerInChargeMe);
    expect(ids).toContain(f.retainerManagerMe);
  });

  it('excludes retainers on engagements the user has no relationship to', async () => {
    const f = await setupScopeFixture();
    const ids = await listMineIds(f.firmId, f.meUserId);
    expect(ids).not.toContain(f.retainerForOther);
  });

  it('the other user sees only their own retainer', async () => {
    const f = await setupScopeFixture();
    const ids = await listMineIds(f.firmId, f.otherUserId);
    expect(ids).toEqual([f.retainerForOther]);
  });
});
