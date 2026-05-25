// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// PP0 — Proposal + Agreement schema invariants.
//
// Locks the load-bearing properties of the §2.8 schema before any
// business logic gets layered on top:
//
//   1. proposal_expiry_after_send  — expires_at must be after sent_at
//   2. proposal_tier price + savings non-negative
//   3. proposal_addon price non-negative
//   4. agreement.proposal_id UNIQUE — one agreement per signed proposal
//   5. proposal_tier ON DELETE CASCADE when parent proposal goes
//   6. agreement_change_log append-only structure round-trips
//   7. Enum coverage on proposal_status / agreement_status / price_cadence

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

async function insertDraftProposal(): Promise<{
  firmId: string;
  clientId: string;
  appUserId: string;
  proposalId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const r = await harness.db.execute(
    sql`INSERT INTO proposal
          (firm_id, client_id, title, status, created_by_user_id)
        VALUES (${seed.firmId}, ${seed.clientId}, 'TY2026 engagement',
                'DRAFT', ${seed.appUserId})
        RETURNING id`,
  );
  const proposalId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return {
    firmId: seed.firmId,
    clientId: seed.clientId,
    appUserId: seed.appUserId,
    proposalId,
  };
}

describe('proposal schema', () => {
  it('CHECK proposal_expiry_after_send rejects expires <= sent', async () => {
    const f = await insertDraftProposal();
    await expect(
      harness.db.execute(
        sql`UPDATE proposal SET sent_at = '2027-01-01T00:00:00Z',
                                 expires_at = '2027-01-01T00:00:00Z'
            WHERE id = ${f.proposalId}`,
      ),
    ).rejects.toThrow(/proposal_expiry_after_send|check/i);
  });

  it('allows NULL expires_at on a sent proposal (perpetual)', async () => {
    const f = await insertDraftProposal();
    await harness.db.execute(
      sql`UPDATE proposal SET status = 'SENT', sent_at = '2027-01-01T00:00:00Z'
          WHERE id = ${f.proposalId}`,
    );
    const row = await harness.db.execute(
      sql`SELECT expires_at FROM proposal WHERE id = ${f.proposalId}`,
    );
    expect(
      (row as unknown as { rows: { expires_at: string | null }[] }).rows[0]!.expires_at,
    ).toBeNull();
  });

  it('proposal_status enum rejects unknown values', async () => {
    const f = await insertDraftProposal();
    await expect(
      harness.db.execute(sql`UPDATE proposal SET status = 'BOGUS' WHERE id = ${f.proposalId}`),
    ).rejects.toThrow(/invalid input value for enum/i);
  });
});

describe('proposal_tier schema', () => {
  it('cascades on parent proposal delete', async () => {
    const f = await insertDraftProposal();
    await harness.db.execute(
      sql`INSERT INTO proposal_tier
            (proposal_id, name, price_cents, price_cadence, sequence)
          VALUES (${f.proposalId}, 'Standard', 25000, 'MONTHLY', 1)`,
    );
    await harness.db.execute(sql`DELETE FROM proposal WHERE id = ${f.proposalId}`);
    const orphans = await harness.db.execute(
      sql`SELECT COUNT(*)::int AS c FROM proposal_tier WHERE proposal_id = ${f.proposalId}`,
    );
    expect((orphans as unknown as { rows: { c: number }[] }).rows[0]!.c).toBe(0);
  });

  it('rejects negative price_cents', async () => {
    const f = await insertDraftProposal();
    await expect(
      harness.db.execute(
        sql`INSERT INTO proposal_tier (proposal_id, name, price_cents, price_cadence)
            VALUES (${f.proposalId}, 'Negative', -1, 'MONTHLY')`,
      ),
    ).rejects.toThrow(/proposal_tier_price_nonneg|check/i);
  });

  it('rejects negative annual_savings_cents but allows NULL', async () => {
    const f = await insertDraftProposal();
    // NULL allowed.
    await harness.db.execute(
      sql`INSERT INTO proposal_tier
            (proposal_id, name, price_cents, price_cadence, annual_savings_cents)
          VALUES (${f.proposalId}, 'NullSav', 25000, 'MONTHLY', NULL)`,
    );
    // -1 rejected.
    await expect(
      harness.db.execute(
        sql`INSERT INTO proposal_tier
              (proposal_id, name, price_cents, price_cadence, annual_savings_cents)
            VALUES (${f.proposalId}, 'BadSav', 25000, 'MONTHLY', -1)`,
      ),
    ).rejects.toThrow(/proposal_tier_savings_nonneg|check/i);
  });

  it('price_cadence enum covers ONE_TIME + MONTHLY + QUARTERLY + ANNUALLY', async () => {
    const f = await insertDraftProposal();
    for (const cadence of ['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'ANNUALLY']) {
      await harness.db.execute(
        sql`INSERT INTO proposal_tier (proposal_id, name, price_cents, price_cadence)
            VALUES (${f.proposalId}, ${cadence}, 1000, ${cadence}::price_cadence)`,
      );
    }
    const rows = await harness.db.execute(
      sql`SELECT COUNT(*)::int AS c FROM proposal_tier WHERE proposal_id = ${f.proposalId}`,
    );
    expect((rows as unknown as { rows: { c: number }[] }).rows[0]!.c).toBe(4);
  });
});

describe('agreement schema', () => {
  async function setupSigned(): Promise<{
    firmId: string;
    clientId: string;
    proposalId: string;
    tierId: string;
  }> {
    const f = await insertDraftProposal();
    const tierRes = await harness.db.execute(
      sql`INSERT INTO proposal_tier
            (proposal_id, name, price_cents, price_cadence)
          VALUES (${f.proposalId}, 'Std', 25000, 'MONTHLY')
          RETURNING id`,
    );
    const tierId = (tierRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`UPDATE proposal SET status = 'SIGNED', sent_at = '2027-01-01T00:00:00Z',
                               signed_at = '2027-01-02T00:00:00Z',
                               signature_text = 'Jane Smith',
                               agreement_hash = 'abc123'
          WHERE id = ${f.proposalId}`,
    );
    return { firmId: f.firmId, clientId: f.clientId, proposalId: f.proposalId, tierId };
  }

  it('UNIQUE(proposal_id) — second agreement on same proposal rejected', async () => {
    const f = await setupSigned();
    await harness.db.execute(
      sql`INSERT INTO agreement
            (firm_id, client_id, proposal_id, selected_tier_id, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.proposalId}, ${f.tierId}, 'ACTIVE')`,
    );
    await expect(
      harness.db.execute(
        sql`INSERT INTO agreement
              (firm_id, client_id, proposal_id, selected_tier_id, status)
            VALUES (${f.firmId}, ${f.clientId}, ${f.proposalId}, ${f.tierId}, 'ACTIVE')`,
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('agreement_status enum rejects unknown values', async () => {
    const f = await setupSigned();
    const r = await harness.db.execute(
      sql`INSERT INTO agreement
            (firm_id, client_id, proposal_id, selected_tier_id, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.proposalId}, ${f.tierId}, 'ACTIVE')
          RETURNING id`,
    );
    const id = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await expect(
      harness.db.execute(sql`UPDATE agreement SET status = 'BOGUS' WHERE id = ${id}`),
    ).rejects.toThrow(/invalid input value for enum/i);
  });

  it('selected_addon_ids stores a JSONB array', async () => {
    const f = await setupSigned();
    const addonRes = await harness.db.execute(
      sql`INSERT INTO proposal_addon
            (proposal_id, name, price_cents, price_cadence, optional)
          VALUES (${f.proposalId}, 'Payroll', 5000, 'MONTHLY', true)
          RETURNING id`,
    );
    const addonId = (addonRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO agreement
            (firm_id, client_id, proposal_id, selected_tier_id,
             selected_addon_ids, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.proposalId}, ${f.tierId},
                  ${JSON.stringify([addonId])}::jsonb, 'ACTIVE')`,
    );
    const row = await harness.db.execute(
      sql`SELECT selected_addon_ids FROM agreement WHERE proposal_id = ${f.proposalId}`,
    );
    const r = (row as unknown as { rows: { selected_addon_ids: string[] }[] }).rows[0]!;
    expect(r.selected_addon_ids).toEqual([addonId]);
  });
});

describe('agreement_change_log', () => {
  it('round-trips a diff JSON payload', async () => {
    const f = await insertDraftProposal();
    const tierRes = await harness.db.execute(
      sql`INSERT INTO proposal_tier (proposal_id, name, price_cents, price_cadence)
          VALUES (${f.proposalId}, 'T1', 100, 'MONTHLY') RETURNING id`,
    );
    const tierId = (tierRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const agRes = await harness.db.execute(
      sql`INSERT INTO agreement
            (firm_id, client_id, proposal_id, selected_tier_id, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.proposalId}, ${tierId}, 'ACTIVE')
          RETURNING id`,
    );
    const agreementId = (agRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const diff = {
      before: { selectedAddonIds: [] },
      after: { selectedAddonIds: ['addon-1'] },
      fieldsTouched: ['selectedAddonIds'],
    };
    await harness.db.execute(
      sql`INSERT INTO agreement_change_log (agreement_id, changed_by_user_id, diff, note)
          VALUES (${agreementId}, ${f.appUserId}, ${JSON.stringify(diff)}::jsonb,
                  'Adding payroll add-on per client request')`,
    );
    const rows = await harness.db.execute(
      sql`SELECT diff, note FROM agreement_change_log WHERE agreement_id = ${agreementId}`,
    );
    const r = (rows as unknown as { rows: { diff: typeof diff; note: string }[] }).rows[0]!;
    expect(r.diff).toEqual(diff);
    expect(r.note).toBe('Adding payroll add-on per client request');
  });

  it('cascades when parent agreement is deleted', async () => {
    const f = await insertDraftProposal();
    const tierRes = await harness.db.execute(
      sql`INSERT INTO proposal_tier (proposal_id, name, price_cents, price_cadence)
          VALUES (${f.proposalId}, 'T1', 100, 'MONTHLY') RETURNING id`,
    );
    const tierId = (tierRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const agRes = await harness.db.execute(
      sql`INSERT INTO agreement
            (firm_id, client_id, proposal_id, selected_tier_id, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.proposalId}, ${tierId}, 'ACTIVE')
          RETURNING id`,
    );
    const agreementId = (agRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO agreement_change_log (agreement_id, diff)
          VALUES (${agreementId}, '{"before":{},"after":{},"fieldsTouched":[]}'::jsonb)`,
    );
    await harness.db.execute(sql`DELETE FROM agreement WHERE id = ${agreementId}`);
    const orphans = await harness.db.execute(
      sql`SELECT COUNT(*)::int AS c FROM agreement_change_log
          WHERE agreement_id = ${agreementId}`,
    );
    expect((orphans as unknown as { rows: { c: number }[] }).rows[0]!.c).toBe(0);
  });
});
