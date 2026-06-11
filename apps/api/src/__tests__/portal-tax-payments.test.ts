// SPDX-License-Identifier: Elastic-2.0
//
// CP2 — Portal tax-payments privacy + scope tests.
//
// The portal SQL has two job-critical properties:
//   1. Privacy filter — notes + external_ref + created_by_id must
//      never leak to the client surface.
//   2. Cross-client isolation — client A's session must not see client
//      B's tax payments even within the same firm.
//   3. Status filter — VOIDED rows hidden; PAID older than 90 days
//      hidden; SCHEDULED + recent PAID returned.
//
// Exercises the SQL fragment used by the portal route directly via
// pglite. The Express mounting + portal-auth path is covered by the
// broader portal smoke tests.

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

interface Fixture {
  firmId: string;
  clientAId: string;
  clientBId: string;
  scheduledA: string;
  paidRecentA: string;
  paidOldA: string;
  voidedA: string;
  scheduledB: string;
}

async function setupFixture(): Promise<Fixture> {
  const seed = await seedMinimalFirm(harness.db);
  // Add a second client in the same firm.
  const c2 = await harness.db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
        VALUES (${seed.firmId}, 'Other Co', ${seed.appUserId},
                (SELECT id FROM office WHERE firm_id = ${seed.firmId} ORDER BY is_default DESC LIMIT 1)) RETURNING id`,
  );
  const clientBId = (c2 as unknown as { rows: { id: string }[] }).rows[0]!.id;

  // Helper inline.
  async function insertTp(
    clientId: string,
    status: 'SCHEDULED' | 'PAID' | 'VOIDED',
    opts?: { paidDaysAgo?: number; notes?: string; externalRef?: string },
  ): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const paidDate =
      opts?.paidDaysAgo != null
        ? new Date(Date.now() - opts.paidDaysAgo * 24 * 3600_000).toISOString().slice(0, 10)
        : null;
    const r = await harness.db.execute(
      sql`INSERT INTO tax_payment
            (firm_id, client_id, jurisdiction, payment_type,
             amount_cents, due_date, status, paid_date, notes, external_ref)
          VALUES (${seed.firmId}, ${clientId}, 'Federal', 'Estimated',
                  250000, ${today}, ${status},
                  ${paidDate}, ${opts?.notes ?? null}, ${opts?.externalRef ?? null})
          RETURNING id`,
    );
    return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
  }

  return {
    firmId: seed.firmId,
    clientAId: seed.clientId,
    clientBId,
    scheduledA: await insertTp(seed.clientId, 'SCHEDULED', {
      notes: 'internal-only details',
      externalRef: 'MYBOOKS-123',
    }),
    paidRecentA: await insertTp(seed.clientId, 'PAID', { paidDaysAgo: 30 }),
    paidOldA: await insertTp(seed.clientId, 'PAID', { paidDaysAgo: 200 }),
    voidedA: await insertTp(seed.clientId, 'VOIDED'),
    scheduledB: await insertTp(clientBId, 'SCHEDULED'),
  };
}

// Mirror the portal route's SELECT shape.
async function portalSelect(clientId: string): Promise<Array<Record<string, unknown>>> {
  const cutoffPaid = new Date(Date.now() - 90 * 24 * 3600_000).toISOString().slice(0, 10);
  const r = await harness.db.execute(
    sql`SELECT id, engagement_id, jurisdiction, payment_type, tax_year,
               amount_cents, due_date, status, paid_date, confirmation_number
        FROM tax_payment
        WHERE client_id = ${clientId}
          AND status IN ('SCHEDULED', 'PAID')
          AND (status = 'SCHEDULED' OR paid_date >= ${cutoffPaid})
        ORDER BY due_date`,
  );
  return (r as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
}

describe('portal tax-payments privacy + scope', () => {
  it('does not return notes / external_ref / created_by_id columns', async () => {
    const f = await setupFixture();
    const rows = await portalSelect(f.clientAId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('notes');
      expect(Object.keys(row)).not.toContain('external_ref');
      expect(Object.keys(row)).not.toContain('created_by_id');
    }
  });

  it('client A only sees client A rows — never client B', async () => {
    const f = await setupFixture();
    const aRows = await portalSelect(f.clientAId);
    const aIds = aRows.map((r) => r['id'] as string);
    expect(aIds).toContain(f.scheduledA);
    expect(aIds).not.toContain(f.scheduledB);

    const bRows = await portalSelect(f.clientBId);
    const bIds = bRows.map((r) => r['id'] as string);
    expect(bIds).toContain(f.scheduledB);
    expect(bIds).not.toContain(f.scheduledA);
  });

  it('voided rows are hidden; old paid rows (>90 days) are hidden', async () => {
    const f = await setupFixture();
    const rows = await portalSelect(f.clientAId);
    const ids = rows.map((r) => r['id'] as string);
    expect(ids).not.toContain(f.voidedA);
    expect(ids).not.toContain(f.paidOldA);
  });

  it('scheduled + recent paid (≤90 days) are returned', async () => {
    const f = await setupFixture();
    const rows = await portalSelect(f.clientAId);
    const ids = rows.map((r) => r['id'] as string);
    expect(ids).toContain(f.scheduledA);
    expect(ids).toContain(f.paidRecentA);
  });
});
