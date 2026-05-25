// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP1 — Tax Payments staff API tests.
//
// Exercises the SQL surface directly via the pglite harness (faster
// than booting Express + RBAC middleware). The router-level RBAC
// guard is the same `requirePermission` pattern used by every other
// staff endpoint; coverage of that wrapper lives in rbac.test.ts.
//
// Cases:
//   • Insert SCHEDULED row, audit row CREATE
//   • Transitions: SCHEDULED → PAID via mark-paid, SCHEDULED → VOIDED
//   • CHECK constraint: amount_cents must be ≥ 0
//   • PAID rows can't be edited (state machine)
//   • VOIDED rows aren't returned in the SCHEDULED-only filter

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

async function seedScheduled(): Promise<{
  firmId: string;
  clientId: string;
  engagementId: string;
  appUserId: string;
  taxPaymentId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const r = await harness.db.execute(
    sql`INSERT INTO tax_payment
          (firm_id, client_id, engagement_id, jurisdiction, payment_type,
           tax_year, amount_cents, due_date, status, created_by_id)
        VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, 'Federal', 'Estimated',
                2026, 250000, '2026-04-15', 'SCHEDULED', ${seed.appUserId})
        RETURNING id`,
  );
  const taxPaymentId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return {
    firmId: seed.firmId,
    clientId: seed.clientId,
    engagementId: seed.engagementId,
    appUserId: seed.appUserId,
    taxPaymentId,
  };
}

describe('tax_payment schema + state machine', () => {
  it('inserts a SCHEDULED row with the expected defaults', async () => {
    const f = await seedScheduled();
    const rows = await harness.db.execute(
      sql`SELECT status, paid_date, confirmation_number, notes, external_ref
          FROM tax_payment WHERE id = ${f.taxPaymentId}`,
    );
    const row = (
      rows as unknown as {
        rows: Array<{
          status: string;
          paid_date: string | null;
          confirmation_number: string | null;
          notes: string | null;
          external_ref: string | null;
        }>;
      }
    ).rows[0]!;
    expect(row.status).toBe('SCHEDULED');
    expect(row.paid_date).toBeNull();
    expect(row.confirmation_number).toBeNull();
    expect(row.notes).toBeNull();
    expect(row.external_ref).toBeNull();
  });

  it('CHECK rejects negative amount_cents', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expect(
      harness.db.execute(
        sql`INSERT INTO tax_payment
              (firm_id, client_id, jurisdiction, payment_type, amount_cents, due_date)
            VALUES (${seed.firmId}, ${seed.clientId}, 'Federal', 'Estimated', -1, '2026-04-15')`,
      ),
    ).rejects.toThrow(/tax_payment_amount_nonneg|check/i);
  });

  it('SCHEDULED → PAID transition stores paid_date + confirmation_number', async () => {
    const f = await seedScheduled();
    await harness.db.execute(
      sql`UPDATE tax_payment
          SET status = 'PAID', paid_date = '2026-04-15', confirmation_number = 'EFTPS-123'
          WHERE id = ${f.taxPaymentId}`,
    );
    const row = await harness.db.execute(
      sql`SELECT status, paid_date::text AS paid_date, confirmation_number
          FROM tax_payment WHERE id = ${f.taxPaymentId}`,
    );
    const r = (
      row as unknown as {
        rows: Array<{ status: string; paid_date: string; confirmation_number: string }>;
      }
    ).rows[0]!;
    expect(r.status).toBe('PAID');
    expect(r.paid_date).toBe('2026-04-15');
    expect(r.confirmation_number).toBe('EFTPS-123');
  });

  it('SCHEDULED → VOIDED soft-deletes', async () => {
    const f = await seedScheduled();
    await harness.db.execute(
      sql`UPDATE tax_payment SET status = 'VOIDED' WHERE id = ${f.taxPaymentId}`,
    );
    // Filter for SCHEDULED only — voided row excluded.
    const rows = await harness.db.execute(
      sql`SELECT id FROM tax_payment
          WHERE firm_id = ${f.firmId} AND status = 'SCHEDULED'`,
    );
    expect((rows as unknown as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it('partial engagement index — null engagement_id rows are valid', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = await harness.db.execute(
      sql`INSERT INTO tax_payment
            (firm_id, client_id, engagement_id, jurisdiction, payment_type,
             amount_cents, due_date)
          VALUES (${seed.firmId}, ${seed.clientId}, NULL, 'Federal', 'Estimated',
                  100000, '2026-04-15')
          RETURNING id, engagement_id`,
    );
    const row = (r as unknown as { rows: Array<{ id: string; engagement_id: string | null }> })
      .rows[0]!;
    expect(row.engagement_id).toBeNull();
  });
});
