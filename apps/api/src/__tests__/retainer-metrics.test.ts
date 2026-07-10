// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// R6-followup — coverage for the retainer Prometheus gauge collector.
// The function is a pure projection over the retainer + retainer_offer
// tables, so a pglite harness gives us deterministic counts.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { collectRetainerMetricsText } from '../health/retainer-health';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function makeTierConfig(firmId: string): Promise<string> {
  const r = await harness.db.execute(
    sql`INSERT INTO retainer_tier_config
          (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps)
        VALUES (${firmId}, '1040', 'TIER_1', 'Standard', 10, 25000, 1000)
        RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

describe('collectRetainerMetricsText', () => {
  it('emits zero gauges when no retainers exist', async () => {
    const text = await collectRetainerMetricsText(harness.db);
    expect(text).toMatch(/retainer_active_count\{service="api"\} 0/);
    expect(text).toMatch(/retainer_hours_remaining_total\{service="api"\} 0/);
    expect(text).toMatch(/retainer_expiring_30d\{service="api"\} 0/);
    expect(text).toMatch(/retainer_offers_pending\{service="api"\} 0/);
    expect(text).toMatch(/retainer_deferred_liability_cents\{service="api"\} 0/);
  });

  it('counts active retainers + sums remaining hours + deferred liability', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tc = await makeTierConfig(seed.firmId);
    // Two active retainers, one void.
    await harness.db.execute(
      sql`INSERT INTO retainer
            (firm_id, client_id, engagement_id, tier, return_type, tax_year,
             tier_config_id, name, hours_purchased, hours_consumed, price_cents,
             purchase_date, expiry_date, status)
          VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, 'TIER_1', '1040', 2026,
                  ${tc}, 'Standard', 10, 3, 100000,
                  '2026-05-24', '2029-05-24', 'active')`,
    );
    // Second active retainer — separate engagement.
    const c2 = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${seed.firmId}, 'Other Co', ${seed.appUserId},
                  (SELECT id FROM office WHERE firm_id = ${seed.firmId} ORDER BY is_default DESC LIMIT 1)) RETURNING id`,
    );
    const c2Id = (c2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const e2 = await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure)
          VALUES (${c2Id}, 'TY2026', 'HOURLY') RETURNING id`,
    );
    const e2Id = (e2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO retainer
            (firm_id, client_id, engagement_id, tier, return_type, tax_year,
             tier_config_id, name, hours_purchased, hours_consumed, price_cents,
             purchase_date, expiry_date, status)
          VALUES (${seed.firmId}, ${c2Id}, ${e2Id}, 'TIER_2', '1040', 2026,
                  ${tc}, 'Premium', 20, 5, 200000,
                  '2026-05-24', '2029-05-24', 'active')`,
    );
    // Void retainer — should NOT contribute to any active-* gauge.
    const c3 = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${seed.firmId}, 'Third Co', ${seed.appUserId},
                  (SELECT id FROM office WHERE firm_id = ${seed.firmId} ORDER BY is_default DESC LIMIT 1)) RETURNING id`,
    );
    const c3Id = (c3 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const e3 = await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure)
          VALUES (${c3Id}, 'TY2026', 'HOURLY') RETURNING id`,
    );
    const e3Id = (e3 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO retainer
            (firm_id, client_id, engagement_id, tier, return_type, tax_year,
             tier_config_id, name, hours_purchased, hours_consumed, price_cents,
             purchase_date, expiry_date, status)
          VALUES (${seed.firmId}, ${c3Id}, ${e3Id}, 'TIER_1', '1040', 2026,
                  ${tc}, 'Standard', 10, 0, 100000,
                  '2026-05-24', '2029-05-24', 'void')`,
    );

    const text = await collectRetainerMetricsText(harness.db);
    expect(text).toMatch(/retainer_active_count\{service="api"\} 2/);
    // 7 hours remaining + 15 hours remaining = 22
    expect(text).toMatch(/retainer_hours_remaining_total\{service="api"\} 22/);
    // Deferred liability: 100000 * (7/10) + 200000 * (15/20) = 70000 + 150000 = 220000
    expect(text).toMatch(/retainer_deferred_liability_cents\{service="api"\} 220000/);
  });

  it('counts pending offers (not pending_payment)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tc = await makeTierConfig(seed.firmId);
    const inv = await harness.db.execute(
      sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                                issue_date, due_date, subtotal_cents, total_cents, status)
          VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, 'INV-1',
                  '2026-01-01', '2026-02-01', 50000, 50000, 'DRAFT')
          RETURNING id`,
    );
    const invoiceId = (inv as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO retainer_offer
            (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
             prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
             tier_1_price_cents, tier_2_price_cents, offer_expires_at, status)
          VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, ${invoiceId}, '1040', 2026,
                  150000, ${tc}, ${tc}, 50000, 100000, NOW() + INTERVAL '30 days', 'pending')`,
    );
    const text = await collectRetainerMetricsText(harness.db);
    expect(text).toMatch(/retainer_offers_pending\{service="api"\} 1/);
  });
});
