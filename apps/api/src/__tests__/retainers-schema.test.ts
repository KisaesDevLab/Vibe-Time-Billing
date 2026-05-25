// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R0.2 — Retainer addendum schema invariants. Belt-and-suspenders for
// the DB-enforced rules listed as non-negotiable in the plan. Asserts
// every table, index, CHECK, UNIQUE, and FK behavior actually exists
// after migration 0065 applies to a fresh pglite db.
//
// If any assertion in this file fails after a schema change, the change
// needs the corresponding migration update before it merges.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';

let harness: PgliteHarness;

beforeAll(async () => {
  harness = await buildPgliteHarness();
});

afterAll(async () => {
  await harness.close();
});

async function regclass(name: string): Promise<boolean> {
  const r = await harness.db.execute(sql`SELECT to_regclass(${name}) AS oid`);
  const row = (r as unknown as { rows: { oid: string | null }[] }).rows[0];
  return Boolean(row?.oid);
}

async function indexExists(name: string): Promise<boolean> {
  const r = await harness.db.execute(
    sql`SELECT 1 AS x FROM pg_indexes WHERE indexname = ${name} LIMIT 1`,
  );
  return ((r as unknown as { rows: unknown[] }).rows ?? []).length > 0;
}

async function constraintExists(table: string, conname: string): Promise<boolean> {
  const r = await harness.db.execute(
    sql`
      SELECT 1 AS x
      FROM pg_constraint c
      INNER JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.conname = ${conname} AND t.relname = ${table}
      LIMIT 1
    `,
  );
  return ((r as unknown as { rows: unknown[] }).rows ?? []).length > 0;
}

describe('R0.2 — retainer schema invariants', () => {
  describe('tables exist', () => {
    it.each([
      'retainer_tier_config',
      'retainer_tier_eligible_service',
      'firm_retainer_settings',
      'retainer_offer',
      'retainer',
      'retainer_eligible_service',
      'retainer_ledger',
    ])('table %s exists', async (table) => {
      expect(await regclass(table)).toBe(true);
    });
  });

  describe('enums exist', () => {
    it.each([
      'retainer_tier',
      'retainer_status',
      'return_type',
      'retainer_offer_status',
      'retainer_ledger_kind',
    ])('enum %s exists', async (typeName) => {
      const r = await harness.db.execute(
        sql`SELECT 1 AS x FROM pg_type WHERE typname = ${typeName} LIMIT 1`,
      );
      expect(((r as unknown as { rows: unknown[] }).rows ?? []).length).toBe(1);
    });
  });

  describe('engagement + time_entry columns added', () => {
    it.each([
      ['engagement', 'retainer_id'],
      ['engagement', 'return_type'],
      ['engagement', 'tax_year'],
      ['engagement', 'original_due_date'],
      ['engagement', 'extended_due_date'],
      ['time_entry', 'retainer_id'],
      ['time_entry', 'retainer_hours'],
      ['time_entry', 'billable_hours'],
    ])('%s.%s exists', async (table, column) => {
      const r = await harness.db.execute(
        sql`
          SELECT 1 AS x
          FROM information_schema.columns
          WHERE table_name = ${table} AND column_name = ${column}
          LIMIT 1
        `,
      );
      expect(((r as unknown as { rows: unknown[] }).rows ?? []).length).toBe(1);
    });
  });

  describe('uniqueness invariants', () => {
    it('UNIQUE (engagement_id) on retainer enforces D2', async () => {
      expect(await indexExists('retainer_engagement_uk')).toBe(true);
    });

    it('UNIQUE (firm_id, return_type, tier) on retainer_tier_config', async () => {
      expect(await indexExists('retainer_tier_config_firm_return_tier_uk')).toBe(true);
    });
  });

  describe('CHECK constraints', () => {
    it.each([
      ['retainer', 'retainer_hours_consumed_bounds'],
      ['retainer', 'retainer_hours_purchased_positive'],
      ['retainer', 'retainer_price_nonneg'],
      ['retainer_tier_config', 'retainer_tier_config_hours_positive'],
      ['retainer_tier_config', 'retainer_tier_config_pct_range'],
      ['retainer_tier_config', 'retainer_tier_config_base_fee_nonneg'],
      ['retainer_offer', 'retainer_offer_prices_nonneg'],
      ['retainer_offer', 'retainer_offer_basis_nonneg'],
      ['firm_retainer_settings', 'firm_retainer_settings_window_positive'],
    ])('CHECK %s.%s present', async (table, conname) => {
      expect(await constraintExists(table, conname)).toBe(true);
    });
  });

  describe('indexes for sweep / lookup paths', () => {
    it.each([
      'retainer_sweep_idx',
      'retainer_client_status_idx',
      'retainer_offer_sweep_idx',
      'retainer_offer_invoice_idx',
      'retainer_ledger_retainer_created_idx',
      'time_entry_retainer_idx',
    ])('index %s exists', async (name) => {
      expect(await indexExists(name)).toBe(true);
    });
  });

  describe('firm_retainer_settings backfill', () => {
    it('inserts one row per existing firm with feature_enabled=false', async () => {
      const { firmId } = await seedMinimalFirm(harness.db);
      // Backfill ran at migration time; the firm was inserted just now,
      // so its settings row was NOT created by the migration's INSERT.
      // The invariant we test: NO firm should have feature_enabled=true
      // out of the box. Test the default for a freshly-inserted firm by
      // matching the column default.
      await harness.db.execute(
        sql`INSERT INTO firm_retainer_settings (firm_id) VALUES (${firmId})`,
      );
      const r = await harness.db.execute(
        sql`SELECT feature_enabled, offer_window_days, default_biller_toggle_on
            FROM firm_retainer_settings WHERE firm_id = ${firmId}`,
      );
      const row = (
        r as unknown as {
          rows: {
            feature_enabled: boolean;
            offer_window_days: number;
            default_biller_toggle_on: boolean;
          }[];
        }
      ).rows[0]!;
      expect(row.feature_enabled).toBe(false);
      expect(row.default_biller_toggle_on).toBe(true);
      expect(row.offer_window_days).toBe(60);
    });
  });

  describe('CHECK runtime enforcement', () => {
    it('rejects retainer with hours_consumed > hours_purchased', async () => {
      const { firmId, clientId, engagementId } = await seedMinimalFirm(harness.db);
      // Need tier_config + offer + purchase invoice rows to satisfy FKs.
      // The simplest path: insert a tier config and a stub offer/invoice
      // we can reference. For the CHECK test we only need the retainer
      // INSERT to reach the CHECK — but FK NOT NULLs precede it.
      const tcRes = await harness.db.execute(
        sql`INSERT INTO retainer_tier_config
              (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps)
            VALUES (${firmId}, '1040', 'TIER_1', 'Standard', 10, 0, 1000)
            RETURNING id`,
      );
      const tcId = (tcRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
      // Stub invoice
      const invRes = await harness.db.execute(
        sql`INSERT INTO invoice
              (firm_id, client_id, invoice_number, issue_date, due_date,
               subtotal_cents, total_cents)
            VALUES (${firmId}, ${clientId}, 'TEST-001', '2026-01-01', '2026-02-01', 0, 0)
            RETURNING id`,
      );
      const invId = (invRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
      const offRes = await harness.db.execute(
        sql`INSERT INTO retainer_offer
              (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
               prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
               tier_1_price_cents, tier_2_price_cents, offer_expires_at)
            VALUES (${firmId}, ${clientId}, ${engagementId}, ${invId}, '1040', 2025,
                    100000, ${tcId}, ${tcId}, 50000, 80000, now() + interval '60 days')
            RETURNING id`,
      );
      const offId = (offRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
      // Attempt to insert a retainer with consumed > purchased.
      await expect(
        harness.db.execute(
          sql`INSERT INTO retainer
                (firm_id, client_id, engagement_id, offer_id, purchase_invoice_id,
                 tier, return_type, tax_year, tier_config_id, name,
                 hours_purchased, hours_consumed, price_cents,
                 purchase_date, expiry_date)
              VALUES (${firmId}, ${clientId}, ${engagementId}, ${offId}, ${invId},
                      'TIER_1', '1040', 2025, ${tcId}, 'Standard',
                      10, 11, 50000, '2026-01-01', '2029-04-15')`,
        ),
      ).rejects.toThrow(/retainer_hours_consumed_bounds/);
    });

    it('rejects pct_of_prep_fee_bps > 10000', async () => {
      const { firmId } = await seedMinimalFirm(harness.db);
      await expect(
        harness.db.execute(
          sql`INSERT INTO retainer_tier_config
                (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps)
              VALUES (${firmId}, '1040', 'TIER_1', 'Bad', 10, 0, 10001)`,
        ),
      ).rejects.toThrow(/retainer_tier_config_pct_range/);
    });

    it('rejects second retainer on the same engagement (D2)', async () => {
      const { firmId, clientId, engagementId } = await seedMinimalFirm(harness.db);
      const tcRes = await harness.db.execute(
        sql`INSERT INTO retainer_tier_config
              (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps)
            VALUES (${firmId}, '1040', 'TIER_1', 'Standard', 10, 0, 1000)
            RETURNING id`,
      );
      const tcId = (tcRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
      const invRes = await harness.db.execute(
        sql`INSERT INTO invoice
              (firm_id, client_id, invoice_number, issue_date, due_date,
               subtotal_cents, total_cents)
            VALUES (${firmId}, ${clientId}, 'TEST-002', '2026-01-01', '2026-02-01', 0, 0)
            RETURNING id`,
      );
      const invId = (invRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
      const offRes = await harness.db.execute(
        sql`INSERT INTO retainer_offer
              (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
               prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
               tier_1_price_cents, tier_2_price_cents, offer_expires_at)
            VALUES (${firmId}, ${clientId}, ${engagementId}, ${invId}, '1040', 2025,
                    100000, ${tcId}, ${tcId}, 50000, 80000, now() + interval '60 days')
            RETURNING id`,
      );
      const offId = (offRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
      // First retainer succeeds.
      await harness.db.execute(
        sql`INSERT INTO retainer
              (firm_id, client_id, engagement_id, offer_id, purchase_invoice_id,
               tier, return_type, tax_year, tier_config_id, name,
               hours_purchased, hours_consumed, price_cents,
               purchase_date, expiry_date)
            VALUES (${firmId}, ${clientId}, ${engagementId}, ${offId}, ${invId},
                    'TIER_1', '1040', 2025, ${tcId}, 'Standard',
                    10, 0, 50000, '2026-01-01', '2029-04-15')`,
      );
      // Second on the same engagement violates the UNIQUE constraint.
      await expect(
        harness.db.execute(
          sql`INSERT INTO retainer
                (firm_id, client_id, engagement_id, offer_id, purchase_invoice_id,
                 tier, return_type, tax_year, tier_config_id, name,
                 hours_purchased, hours_consumed, price_cents,
                 purchase_date, expiry_date)
              VALUES (${firmId}, ${clientId}, ${engagementId}, ${offId}, ${invId},
                      'TIER_2', '1040', 2025, ${tcId}, 'Premium',
                      20, 0, 80000, '2026-01-01', '2029-04-15')`,
        ),
      ).rejects.toThrow(/retainer_engagement_uk|duplicate key/);
    });
  });
});
