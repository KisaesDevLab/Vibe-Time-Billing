// SPDX-License-Identifier: Elastic-2.0
//
// R3 — activateRetainerFromPaidInvoice integration. Pglite harness +
// full setup: offer → tier select (creates AR invoice) → mark paid →
// activate. Asserts the retainer row, engagement link, eligibility
// snapshot, and ledger ACTIVATION row.
//
// Idempotency: calling the activation function twice for the same
// invoice returns the same retainer id without inserting a duplicate.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { activateRetainerFromPaidInvoice } from '../retainers/activation';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

/**
 * Full setup helper: returns ids needed by every activation test.
 */
async function setupActivationFixture(opts?: {
  withOverrides?: boolean;
  alternateEngagementHasRetainer?: boolean;
}): Promise<{
  firmId: string;
  clientId: string;
  engagementId: string;
  offerId: string;
  purchaseInvoiceId: string;
  tier1TcId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const { firmId, clientId, engagementId, workCodeId } = seed;

  // firm settings
  await harness.db.execute(
    sql`INSERT INTO firm_retainer_settings (firm_id, feature_enabled, prep_fee_work_code_ids)
        VALUES (${firmId}, true, ${JSON.stringify([workCodeId])}::jsonb)`,
  );

  // engagement: return_type + tax_year + due dates
  await harness.db.execute(
    sql`UPDATE engagement
        SET return_type='1040',
            tax_year=2025,
            original_due_date='2026-04-15',
            extended_due_date='2026-10-15'
        WHERE id = ${engagementId}`,
  );

  // tier configs
  const tcRes = await harness.db.execute(
    sql`INSERT INTO retainer_tier_config
          (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps, is_active)
        VALUES
          (${firmId}, '1040', 'TIER_1', 'Standard', 5, 25000, 1000, true),
          (${firmId}, '1040', 'TIER_2', 'Premium', 12, 50000, 2500, true)
        RETURNING id, tier`,
  );
  const tcRows = (tcRes as unknown as { rows: { id: string; tier: 'TIER_1' | 'TIER_2' }[] }).rows;
  const tier1TcId = tcRows.find((r) => r.tier === 'TIER_1')!.id;
  const tier2TcId = tcRows.find((r) => r.tier === 'TIER_2')!.id;
  // Eligibility: both tiers cover the seed workCode.
  await harness.db.execute(
    sql`INSERT INTO retainer_tier_eligible_service (tier_config_id, work_code_id) VALUES
        (${tier1TcId}, ${workCodeId}),
        (${tier2TcId}, ${workCodeId})`,
  );

  // Source tax-prep invoice (offer's parent)
  const srcInvRes = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                             issue_date, due_date, subtotal_cents, total_cents, status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, 'TAX-001',
                '2026-04-15', '2026-05-15', 150000, 150000, 'SENT')
        RETURNING id`,
  );
  const srcInvId = (srcInvRes as unknown as { rows: { id: string }[] }).rows[0]!.id;

  // Retainer offer (pending → pending_payment when selected)
  const overrides = opts?.withOverrides ? JSON.stringify({ tier1: [workCodeId] }) : null;
  const offerRes = await harness.db.execute(
    sql`INSERT INTO retainer_offer
          (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
           prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
           tier_1_price_cents, tier_2_price_cents, eligibility_overrides_json,
           offer_expires_at, status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, ${srcInvId}, '1040', 2025,
                150000, ${tier1TcId}, ${tier2TcId}, 40000, 87500,
                ${overrides ? sql`${overrides}::jsonb` : sql`NULL`},
                now() + interval '60 days',
                'pending_payment')
        RETURNING id`,
  );
  const offerId = (offerRes as unknown as { rows: { id: string }[] }).rows[0]!.id;

  // The retainer-purchase invoice (issued by the portal-selection path)
  const purchaseInvRes = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id,
                             invoice_number, issue_date, due_date,
                             subtotal_cents, total_cents, status,
                             retainer_offer_id)
        VALUES (${firmId}, ${clientId}, ${engagementId}, 'RET-001',
                '2026-04-15', '2026-04-29', 40000, 40000, 'PAID',
                ${offerId})
        RETURNING id`,
  );
  const purchaseInvoiceId = (purchaseInvRes as unknown as { rows: { id: string }[] }).rows[0]!.id;

  // Mark offer's purchased_tier so activation knows which to use.
  await harness.db.execute(
    sql`UPDATE retainer_offer
        SET purchased_tier = 'TIER_1', purchased_invoice_id = ${purchaseInvoiceId}
        WHERE id = ${offerId}`,
  );

  return { firmId, clientId, engagementId, offerId, purchaseInvoiceId, tier1TcId };
}

describe('activateRetainerFromPaidInvoice (R3)', () => {
  it('happy path: creates retainer + ledger seed + engagement link', async () => {
    const fixture = await setupActivationFixture();
    const r = await activateRetainerFromPaidInvoice(harness.db, fixture.purchaseInvoiceId);
    expect(r.kind).toBe('activated');
    if (r.kind !== 'activated') return;

    const rows = await harness.db.execute(
      sql`SELECT status, hours_purchased::text AS hours_purchased,
                 hours_consumed::text AS hours_consumed, expiry_date,
                 engagement_id, offer_id, price_cents, name, tier
          FROM retainer WHERE id = ${r.retainerId}`,
    );
    const ret = (
      rows as unknown as {
        rows: {
          status: string;
          hours_purchased: string;
          hours_consumed: string;
          expiry_date: string;
          engagement_id: string;
          offer_id: string;
          price_cents: number | string;
          name: string;
          tier: string;
        }[];
      }
    ).rows[0]!;
    expect(ret.status).toBe('active');
    expect(Number(ret.hours_purchased)).toBe(5);
    expect(Number(ret.hours_consumed)).toBe(0);
    // D3: COALESCE(extended=2026-10-15, original) + 3y = 2029-10-15
    expect(new Date(ret.expiry_date).toISOString().slice(0, 10)).toBe('2029-10-15');
    expect(ret.engagement_id).toBe(fixture.engagementId);
    expect(ret.offer_id).toBe(fixture.offerId);
    expect(Number(ret.price_cents)).toBe(40000);
    expect(ret.tier).toBe('TIER_1');

    // Engagement convenience pointer set
    const engRow = await harness.db.execute(
      sql`SELECT retainer_id FROM engagement WHERE id = ${fixture.engagementId}`,
    );
    const engRetainerId = (engRow as unknown as { rows: { retainer_id: string }[] }).rows[0]!
      .retainer_id;
    expect(engRetainerId).toBe(r.retainerId);

    // Offer flipped to purchased
    const offRow = await harness.db.execute(
      sql`SELECT status, purchased_at FROM retainer_offer WHERE id = ${fixture.offerId}`,
    );
    const offData = (offRow as unknown as { rows: { status: string; purchased_at: string }[] })
      .rows[0]!;
    expect(offData.status).toBe('purchased');
    expect(offData.purchased_at).toBeTruthy();

    // Ledger ACTIVATION seed row
    const ledger = await harness.db.execute(
      sql`SELECT kind, hours_delta::text AS hours_delta, hours_balance_after::text AS bal
          FROM retainer_ledger WHERE retainer_id = ${r.retainerId}`,
    );
    const ledgerRows = (
      ledger as unknown as {
        rows: { kind: string; hours_delta: string; bal: string }[];
      }
    ).rows;
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0]!.kind).toBe('ACTIVATION');
    expect(Number(ledgerRows[0]!.hours_delta)).toBe(0);
    expect(Number(ledgerRows[0]!.bal)).toBe(5);

    // Eligibility snapshot (1 row from tier config)
    const elig = await harness.db.execute(
      sql`SELECT work_code_id FROM retainer_eligible_service WHERE retainer_id = ${r.retainerId}`,
    );
    expect((elig as unknown as { rows: unknown[] }).rows.length).toBeGreaterThanOrEqual(1);
  });

  it('idempotent: second call returns the same retainer id', async () => {
    const fixture = await setupActivationFixture();
    const r1 = await activateRetainerFromPaidInvoice(harness.db, fixture.purchaseInvoiceId);
    expect(r1.kind).toBe('activated');
    const r2 = await activateRetainerFromPaidInvoice(harness.db, fixture.purchaseInvoiceId);
    expect(r2.kind).toBe('idempotent');
    if (r1.kind === 'activated' && r2.kind === 'idempotent') {
      expect(r2.retainerId).toBe(r1.retainerId);
    }
    // Only one retainer row exists.
    const count = await harness.db.execute(
      sql`SELECT COUNT(*)::int AS n FROM retainer WHERE engagement_id = ${fixture.engagementId}`,
    );
    expect((count as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(1);
  });

  it('error: invoice without retainer_offer_id is rejected', async () => {
    const { firmId, clientId } = await seedMinimalFirm(harness.db);
    const invRes = await harness.db.execute(
      sql`INSERT INTO invoice (firm_id, client_id, invoice_number, issue_date, due_date,
                               subtotal_cents, total_cents)
          VALUES (${firmId}, ${clientId}, 'PLAIN-001', '2026-01-01', '2026-02-01', 0, 0)
          RETURNING id`,
    );
    const invId = (invRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const r = await activateRetainerFromPaidInvoice(harness.db, invId);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.reason).toBe('invoice_not_a_retainer_purchase');
    }
  });

  it('error: invoice not found returns error', async () => {
    const r = await activateRetainerFromPaidInvoice(
      harness.db,
      '00000000-0000-0000-0000-000000000000',
    );
    expect(r.kind).toBe('error');
  });

  it('error: offer not in pending_payment status is rejected', async () => {
    const fixture = await setupActivationFixture();
    // Set offer to 'pending' (not pending_payment).
    await harness.db.execute(
      sql`UPDATE retainer_offer SET status = 'pending', purchased_invoice_id = NULL, purchased_tier = NULL
          WHERE id = ${fixture.offerId}`,
    );
    // Re-link invoice to the offer (the activation reads invoice.retainer_offer_id).
    const r = await activateRetainerFromPaidInvoice(harness.db, fixture.purchaseInvoiceId);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.reason).toBe('offer_not_pending_payment');
    }
  });

  it('uses extended_due_date over original_due_date in expiry math (D3)', async () => {
    const fixture = await setupActivationFixture();
    const r = await activateRetainerFromPaidInvoice(harness.db, fixture.purchaseInvoiceId);
    expect(r.kind).toBe('activated');
    if (r.kind !== 'activated') return;
    const rows = await harness.db.execute(
      sql`SELECT expiry_date FROM retainer WHERE id = ${r.retainerId}`,
    );
    const expiry = (rows as unknown as { rows: { expiry_date: string }[] }).rows[0]!.expiry_date;
    // 2026-10-15 + 3y = 2029-10-15
    expect(new Date(expiry).toISOString().slice(0, 10)).toBe('2029-10-15');
  });
});
