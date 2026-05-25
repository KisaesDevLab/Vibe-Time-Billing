// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R4 — Worker sweep tests. Runs against the pglite harness so the
// SQL hits the same migrations the worker would use in prod.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { pino } from 'pino';
import { sql } from 'drizzle-orm';

import { runRetainerExpirySweep } from '../../../worker/src/jobs/retainer-expiry-sweep';
import { runRetainerOfferExpirySweep } from '../../../worker/src/jobs/retainer-offer-expiry-sweep';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';

let harness: PgliteHarness;
const silentLog = pino({ level: 'silent' });

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function makeRetainer(status: 'active' | 'exhausted', expiryDate: string): Promise<string> {
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
                10, ${status === 'exhausted' ? 10 : 0}, 25000,
                '2026-01-01', ${expiryDate}, ${status})
        RETURNING id`,
  );
  void workCodeId;
  return (retRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

describe('runRetainerExpirySweep (R4)', () => {
  it('flips active retainer past expiry → expired', async () => {
    const retId = await makeRetainer('active', '2025-01-01');
    const r = await runRetainerExpirySweep(harness.db, silentLog, new Date('2026-05-24'));
    expect(r.expired).toBe(1);
    const rows = await harness.db.execute(sql`SELECT status FROM retainer WHERE id = ${retId}`);
    expect((rows as unknown as { rows: { status: string }[] }).rows[0]!.status).toBe('expired');
  });

  it('flips exhausted retainer past expiry → expired', async () => {
    const retId = await makeRetainer('exhausted', '2025-01-01');
    const r = await runRetainerExpirySweep(harness.db, silentLog, new Date('2026-05-24'));
    expect(r.expired).toBe(1);
    const rows = await harness.db.execute(sql`SELECT status FROM retainer WHERE id = ${retId}`);
    expect((rows as unknown as { rows: { status: string }[] }).rows[0]!.status).toBe('expired');
  });

  it('leaves active retainer in future alone', async () => {
    const retId = await makeRetainer('active', '2029-01-01');
    const r = await runRetainerExpirySweep(harness.db, silentLog, new Date('2026-05-24'));
    expect(r.expired).toBe(0);
    const rows = await harness.db.execute(sql`SELECT status FROM retainer WHERE id = ${retId}`);
    expect((rows as unknown as { rows: { status: string }[] }).rows[0]!.status).toBe('active');
  });
});

describe('runRetainerOfferExpirySweep (R4)', () => {
  it('flips pending offer past expiry → expired', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tcRes = await harness.db.execute(
      sql`INSERT INTO retainer_tier_config
            (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps)
          VALUES (${seed.firmId}, '1040', 'TIER_1', 'Standard', 5, 25000, 1000)
          RETURNING id`,
    );
    const tcId = (tcRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const invRes = await harness.db.execute(
      sql`INSERT INTO invoice (firm_id, client_id, invoice_number, issue_date, due_date,
                               subtotal_cents, total_cents)
          VALUES (${seed.firmId}, ${seed.clientId}, 'I1', '2026-01-01', '2026-02-01', 0, 0)
          RETURNING id`,
    );
    const invId = (invRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const offRes = await harness.db.execute(
      sql`INSERT INTO retainer_offer
            (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
             prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
             tier_1_price_cents, tier_2_price_cents, offer_expires_at, status)
          VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, ${invId},
                  '1040', 2025, 100000, ${tcId}, ${tcId}, 25000, 50000,
                  '2025-01-01'::timestamptz, 'pending')
          RETURNING id`,
    );
    const offId = (offRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const r = await runRetainerOfferExpirySweep(harness.db, silentLog, new Date('2026-05-24'));
    expect(r.expired).toBe(1);
    const rows = await harness.db.execute(
      sql`SELECT status FROM retainer_offer WHERE id = ${offId}`,
    );
    expect((rows as unknown as { rows: { status: string }[] }).rows[0]!.status).toBe('expired');
  });

  it('leaves pending_payment offer alone (AR flow in progress)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tcRes = await harness.db.execute(
      sql`INSERT INTO retainer_tier_config
            (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps)
          VALUES (${seed.firmId}, '1040', 'TIER_1', 'Standard', 5, 25000, 1000)
          RETURNING id`,
    );
    const tcId = (tcRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const invRes = await harness.db.execute(
      sql`INSERT INTO invoice (firm_id, client_id, invoice_number, issue_date, due_date,
                               subtotal_cents, total_cents)
          VALUES (${seed.firmId}, ${seed.clientId}, 'I2', '2026-01-01', '2026-02-01', 0, 0)
          RETURNING id`,
    );
    const invId = (invRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const offRes = await harness.db.execute(
      sql`INSERT INTO retainer_offer
            (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
             prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
             tier_1_price_cents, tier_2_price_cents, offer_expires_at, status)
          VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, ${invId},
                  '1040', 2025, 100000, ${tcId}, ${tcId}, 25000, 50000,
                  '2025-01-01'::timestamptz, 'pending_payment')
          RETURNING id`,
    );
    const offId = (offRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const r = await runRetainerOfferExpirySweep(harness.db, silentLog, new Date('2026-05-24'));
    expect(r.expired).toBe(0);
    const rows = await harness.db.execute(
      sql`SELECT status FROM retainer_offer WHERE id = ${offId}`,
    );
    expect((rows as unknown as { rows: { status: string }[] }).rows[0]!.status).toBe(
      'pending_payment',
    );
  });
});
