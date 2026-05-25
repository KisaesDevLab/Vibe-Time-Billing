// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R2 — maybeCreateRetainerOffer suppression matrix + happy path.
//
// Pglite harness with a minimal firm + engagement + billing batch +
// time entries. Each test toggles one suppression input and asserts
// the right reason fires.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { maybeCreateRetainerOffer } from '../retainers/offers';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

/**
 * Create a firm + engagement + retainer tier configs + a billing batch
 * with time entries against a "tax_prep" work code. Returns ids the
 * tests need to call maybeCreateRetainerOffer with.
 */
async function setupSuiteFixture(opts?: {
  featureEnabled?: boolean;
  hasReturnType?: boolean;
  hasActiveTiers?: boolean;
  hasPrepFeeWorkCode?: boolean;
  alreadyHasRetainer?: boolean;
}): Promise<{
  firmId: string;
  clientId: string;
  engagementId: string;
  invoiceId: string;
  workCodeId: string;
  appUserId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const { firmId, clientId, engagementId, appUserId, workCodeId } = seed;

  // Firm settings.
  const prepFeeJson = opts?.hasPrepFeeWorkCode === false ? '[]' : JSON.stringify([workCodeId]);
  await harness.db.execute(
    sql`INSERT INTO firm_retainer_settings (firm_id, feature_enabled, prep_fee_work_code_ids, offer_window_days)
        VALUES (${firmId},
                ${opts?.featureEnabled !== false},
                ${prepFeeJson}::jsonb,
                60)`,
  );

  // Engagement: set return_type + tax_year unless suppression test demands otherwise.
  const hasReturnType = opts?.hasReturnType !== false;
  if (hasReturnType) {
    await harness.db.execute(
      sql`UPDATE engagement SET return_type = '1040', tax_year = 2025, original_due_date = '2026-04-15'
          WHERE id = ${engagementId}`,
    );
  }

  // Tier configs (active by default unless suppression demands otherwise).
  if (opts?.hasActiveTiers !== false) {
    await harness.db.execute(
      sql`INSERT INTO retainer_tier_config
            (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps, is_active)
          VALUES
            (${firmId}, '1040', 'TIER_1', 'Standard', 5, 25000, 1000, true),
            (${firmId}, '1040', 'TIER_2', 'Premium', 12, 50000, 2500, true)`,
    );
  }

  // Already-has-retainer setup: create a retainer + link engagement.
  if (opts?.alreadyHasRetainer) {
    // Need a stub offer + invoice first.
    const invRes = await harness.db.execute(
      sql`INSERT INTO invoice (firm_id, client_id, invoice_number, issue_date, due_date,
                               subtotal_cents, total_cents)
          VALUES (${firmId}, ${clientId}, 'EXIST-001', '2026-01-01', '2026-02-01', 0, 0)
          RETURNING id`,
    );
    const stubInvId = (invRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const tcRes = await harness.db.execute(
      sql`SELECT id FROM retainer_tier_config WHERE firm_id = ${firmId} AND tier = 'TIER_1' LIMIT 1`,
    );
    const tcId = (tcRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const offRes = await harness.db.execute(
      sql`INSERT INTO retainer_offer
            (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
             prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
             tier_1_price_cents, tier_2_price_cents, offer_expires_at)
          VALUES (${firmId}, ${clientId}, ${engagementId}, ${stubInvId}, '1040', 2025,
                  100000, ${tcId}, ${tcId}, 50000, 80000, now() + interval '60 days')
          RETURNING id`,
    );
    const offId = (offRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const retRes = await harness.db.execute(
      sql`INSERT INTO retainer
            (firm_id, client_id, engagement_id, offer_id, purchase_invoice_id,
             tier, return_type, tax_year, tier_config_id, name,
             hours_purchased, hours_consumed, price_cents, purchase_date, expiry_date)
          VALUES (${firmId}, ${clientId}, ${engagementId}, ${offId}, ${stubInvId},
                  'TIER_1', '1040', 2025, ${tcId}, 'Standard',
                  5, 0, 25000, '2026-01-01', '2029-04-15')
          RETURNING id`,
    );
    const retId = (retRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`UPDATE engagement SET retainer_id = ${retId} WHERE id = ${engagementId}`,
    );
  }

  // Source tax-prep invoice + billing batch + time entries.
  const invRes2 = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, invoice_number, issue_date, due_date,
                             subtotal_cents, total_cents, primary_engagement_id)
        VALUES (${firmId}, ${clientId}, 'TAX-001', '2026-04-15', '2026-05-15', 150000, 150000, ${engagementId})
        RETURNING id`,
  );
  const invoiceId = (invRes2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const batchRes = await harness.db.execute(
    sql`INSERT INTO billing_batch (engagement_id, period_start, period_end, status, created_by_id)
        VALUES (${engagementId}, '2026-01-01', '2026-04-15', 'INVOICED', ${appUserId})
        RETURNING id`,
  );
  const batchId = (batchRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const teRes = await harness.db.execute(
    sql`INSERT INTO time_entry (engagement_id, app_user_id, work_code_id, entry_date,
                                hours, standard_rate_snapshot_cents, standard_amount_cents)
        VALUES (${engagementId}, ${appUserId}, ${workCodeId}, '2026-03-01',
                10, 15000, 150000)
        RETURNING id`,
  );
  const teId = (teRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO billing_batch_entry (billing_batch_id, time_entry_id, action)
        VALUES (${batchId}, ${teId}, 'INCLUDE')`,
  );

  return { firmId, clientId, engagementId, invoiceId, workCodeId, appUserId };
}

describe('maybeCreateRetainerOffer (R2 suppression matrix)', () => {
  it('happy path: creates an offer with computed tier prices', async () => {
    const { firmId, clientId, engagementId, invoiceId } = await setupSuiteFixture();
    const r = await maybeCreateRetainerOffer(harness.db, {
      invoiceId,
      engagementId,
      firmId,
      clientId,
      toggleOn: true,
      invoiceDate: '2026-04-15',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Tier 1: base 25000 + (1000 bps × 150000) / 10000 = 25000 + 15000 = 40000
      expect(r.tier1PriceCents).toBe(40000);
      // Tier 2: base 50000 + (2500 bps × 150000) / 10000 = 50000 + 37500 = 87500
      expect(r.tier2PriceCents).toBe(87500);
      expect(r.basisCents).toBe(150000);
    }
  });

  it('suppress: toggleOn=false returns feature_disabled', async () => {
    const { firmId, clientId, engagementId, invoiceId } = await setupSuiteFixture();
    const r = await maybeCreateRetainerOffer(harness.db, {
      invoiceId,
      engagementId,
      firmId,
      clientId,
      toggleOn: false,
      invoiceDate: '2026-04-15',
    });
    expect(r).toEqual({ ok: false, reason: 'feature_disabled' });
  });

  it('suppress: firm feature_enabled=false returns feature_disabled', async () => {
    const { firmId, clientId, engagementId, invoiceId } = await setupSuiteFixture({
      featureEnabled: false,
    });
    const r = await maybeCreateRetainerOffer(harness.db, {
      invoiceId,
      engagementId,
      firmId,
      clientId,
      toggleOn: true,
      invoiceDate: '2026-04-15',
    });
    expect(r).toEqual({ ok: false, reason: 'feature_disabled' });
  });

  it('suppress: no return_type on engagement returns no_return_type', async () => {
    const { firmId, clientId, engagementId, invoiceId } = await setupSuiteFixture({
      hasReturnType: false,
    });
    const r = await maybeCreateRetainerOffer(harness.db, {
      invoiceId,
      engagementId,
      firmId,
      clientId,
      toggleOn: true,
      invoiceDate: '2026-04-15',
    });
    expect(r).toEqual({ ok: false, reason: 'no_return_type' });
  });

  it('suppress: no active tier_configs returns no_tier_config', async () => {
    const { firmId, clientId, engagementId, invoiceId } = await setupSuiteFixture({
      hasActiveTiers: false,
    });
    const r = await maybeCreateRetainerOffer(harness.db, {
      invoiceId,
      engagementId,
      firmId,
      clientId,
      toggleOn: true,
      invoiceDate: '2026-04-15',
    });
    expect(r).toEqual({ ok: false, reason: 'no_tier_config' });
  });

  it('suppress: engagement already has retainer returns retainer_exists', async () => {
    const { firmId, clientId, engagementId, invoiceId } = await setupSuiteFixture({
      alreadyHasRetainer: true,
    });
    const r = await maybeCreateRetainerOffer(harness.db, {
      invoiceId,
      engagementId,
      firmId,
      clientId,
      toggleOn: true,
      invoiceDate: '2026-04-15',
    });
    expect(r).toEqual({ ok: false, reason: 'retainer_exists' });
  });

  it('suppress: empty prep_fee_work_code_ids → no basis → no_prep_fee_basis', async () => {
    const { firmId, clientId, engagementId, invoiceId } = await setupSuiteFixture({
      hasPrepFeeWorkCode: false,
    });
    const r = await maybeCreateRetainerOffer(harness.db, {
      invoiceId,
      engagementId,
      firmId,
      clientId,
      toggleOn: true,
      invoiceDate: '2026-04-15',
    });
    expect(r).toEqual({ ok: false, reason: 'no_prep_fee_basis' });
  });

  it('overrides: explicit tier1/tier2 prices win over computed values', async () => {
    const { firmId, clientId, engagementId, invoiceId } = await setupSuiteFixture();
    const r = await maybeCreateRetainerOffer(harness.db, {
      invoiceId,
      engagementId,
      firmId,
      clientId,
      toggleOn: true,
      invoiceDate: '2026-04-15',
      overrides: {
        tier1PriceCents: 99900,
        tier2PriceCents: 199900,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tier1PriceCents).toBe(99900);
      expect(r.tier2PriceCents).toBe(199900);
    }
  });

  it('offer_expires_at = invoice_date + offer_window_days (60)', async () => {
    const { firmId, clientId, engagementId, invoiceId } = await setupSuiteFixture();
    const r = await maybeCreateRetainerOffer(harness.db, {
      invoiceId,
      engagementId,
      firmId,
      clientId,
      toggleOn: true,
      invoiceDate: '2026-04-15',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const row = await harness.db.execute(
        sql`SELECT offer_expires_at FROM retainer_offer WHERE id = ${r.offerId}`,
      );
      const expires = (row as unknown as { rows: { offer_expires_at: Date | string }[] }).rows[0]!
        .offer_expires_at;
      const expiresDate = new Date(expires);
      // 2026-04-15 + 60 days = 2026-06-14
      expect(expiresDate.toISOString().slice(0, 10)).toBe('2026-06-14');
    }
  });
});
