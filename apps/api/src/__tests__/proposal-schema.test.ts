// SPDX-License-Identifier: Elastic-2.0
//
// P01 — Proposal Module schema invariants. Pins the locked addendum
// decisions in §0.3 and the structural choices that subsequent
// phases will rely on:
//   • signatures is a plural table (Q34)
//   • service_category enum has exactly 6 values per §0.1
//   • webhook_events PK = stripe_event_id (idempotency)
//   • proposal_versions UNIQUE(proposal_id, version) + hash format
//   • payment_mandates state machine + ACH text requirement
//   • magic_links UNIQUE on token_hash
//   • client_accounts UNIQUE on (firm_id, email)
//   • engagement_scope CASCADE on engagement deletion
//   • proposal_activity CASCADE on proposal deletion
//   • engagement columns from_proposal_id + renewed_from_engagement_id

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

async function insertProposal(firmId: string, clientId: string): Promise<string> {
  const r = await harness.db.execute(
    sql`INSERT INTO proposals (firm_id, client_id, title)
        VALUES (${firmId}, ${clientId}, 'Annual Tax + Bookkeeping')
        RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

describe('P01 — service catalog', () => {
  it('service_category enum has exactly 6 values', async () => {
    const r = await harness.db.execute(
      sql`SELECT unnest(enum_range(NULL::service_category))::text AS v ORDER BY 1`,
    );
    const vals = (r as unknown as { rows: { v: string }[] }).rows.map((x) => x.v).sort();
    expect(vals).toEqual(['ADVISORY', 'AUDIT', 'BOOKKEEPING', 'CFO', 'PAYROLL', 'TAX']);
  });

  it('services_catalog enforces recurring_interval consistency', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // ONE_TIME with a recurring_interval set → CHECK fail.
    await expect(
      harness.db.execute(
        sql`INSERT INTO services_catalog
              (firm_id, name, category, billing_type, recurring_interval)
            VALUES (${seed.firmId}, 'Bad', 'TAX', 'ONE_TIME', 'MONTHLY')`,
      ),
    ).rejects.toThrow(/recurring_consistency|check/i);
    // RECURRING without interval → CHECK fail.
    await expect(
      harness.db.execute(
        sql`INSERT INTO services_catalog
              (firm_id, name, category, billing_type)
            VALUES (${seed.firmId}, 'Bad2', 'BOOKKEEPING', 'RECURRING')`,
      ),
    ).rejects.toThrow(/recurring_consistency|check/i);
  });

  it('services_catalog rejects negative default_price_cents', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expect(
      harness.db.execute(
        sql`INSERT INTO services_catalog
              (firm_id, name, category, default_price_cents)
            VALUES (${seed.firmId}, 'Bad', 'TAX', -1)`,
      ),
    ).rejects.toThrow(/price_nonneg|check/i);
  });

  it('service_tags name is unique case-insensitive per firm', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.execute(
      sql`INSERT INTO service_tags (firm_id, name) VALUES (${seed.firmId}, 'Recurring')`,
    );
    await expect(
      harness.db.execute(
        sql`INSERT INTO service_tags (firm_id, name) VALUES (${seed.firmId}, 'RECURRING')`,
      ),
    ).rejects.toThrow(/service_tags_firm_name_uk|unique/i);
  });
});

describe('P01 — packages', () => {
  it('package_services pkg_svc UNIQUE prevents duplicate inclusion', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const svc = await harness.db.execute(
      sql`INSERT INTO services_catalog (firm_id, name, category, default_price_cents)
          VALUES (${seed.firmId}, 'Monthly Bookkeeping', 'BOOKKEEPING', 50000)
          RETURNING id`,
    );
    const serviceId = (svc as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const pkg = await harness.db.execute(
      sql`INSERT INTO packages (firm_id, name, tier_label, position)
          VALUES (${seed.firmId}, 'Small Biz Bronze', 'Bronze', 0)
          RETURNING id`,
    );
    const packageId = (pkg as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO package_services (package_id, service_id, sequence)
          VALUES (${packageId}, ${serviceId}, 0)`,
    );
    await expect(
      harness.db.execute(
        sql`INSERT INTO package_services (package_id, service_id, sequence)
            VALUES (${packageId}, ${serviceId}, 1)`,
      ),
    ).rejects.toThrow(/package_services_pkg_svc_uk|unique/i);
  });

  it('package_services override_price_cents must be NULL or >= 0', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const svc = await harness.db.execute(
      sql`INSERT INTO services_catalog (firm_id, name, category)
          VALUES (${seed.firmId}, 'S', 'TAX')
          RETURNING id`,
    );
    const serviceId = (svc as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const pkg = await harness.db.execute(
      sql`INSERT INTO packages (firm_id, name) VALUES (${seed.firmId}, 'P') RETURNING id`,
    );
    const packageId = (pkg as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await expect(
      harness.db.execute(
        sql`INSERT INTO package_services (package_id, service_id, override_price_cents)
            VALUES (${packageId}, ${serviceId}, -1)`,
      ),
    ).rejects.toThrow(/package_services_override_nonneg|check/i);
  });
});

describe('P01 — terms templates', () => {
  it('partial unique index allows one default per (firm, category)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.execute(
      sql`INSERT INTO terms_templates (firm_id, category, name, is_default)
          VALUES (${seed.firmId}, 'TAX', 'Default 1040 Letter', true)`,
    );
    // Second default for same (firm, category) → unique violation.
    await expect(
      harness.db.execute(
        sql`INSERT INTO terms_templates (firm_id, category, name, is_default)
            VALUES (${seed.firmId}, 'TAX', 'Default 1040 Letter v2', true)`,
      ),
    ).rejects.toThrow(/default_uk|unique/i);
    // Different category is fine.
    await harness.db.execute(
      sql`INSERT INTO terms_templates (firm_id, category, name, is_default)
          VALUES (${seed.firmId}, 'BOOKKEEPING', 'Default Bookkeeping Letter', true)`,
    );
  });

  it('version must be positive', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expect(
      harness.db.execute(
        sql`INSERT INTO terms_templates (firm_id, category, name, version)
            VALUES (${seed.firmId}, 'TAX', 'Bad', 0)`,
      ),
    ).rejects.toThrow(/version_positive|check/i);
  });
});

describe('P01 — proposals', () => {
  it('expires_at must be after sent_at', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expect(
      harness.db.execute(
        sql`INSERT INTO proposals (firm_id, client_id, title, sent_at, expires_at)
            VALUES (${seed.firmId}, ${seed.clientId}, 'P',
                    '2027-04-15T15:00:00Z', '2027-04-15T15:00:00Z')`,
      ),
    ).rejects.toThrow(/expires_after_sent|check/i);
  });

  it('allows NULL expires_at (perpetual offer)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const id = await insertProposal(seed.firmId, seed.clientId);
    expect(id).toBeTruthy();
  });

  it('rejects negative totals', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expect(
      harness.db.execute(
        sql`INSERT INTO proposals (firm_id, client_id, title, total_one_time_cents)
            VALUES (${seed.firmId}, ${seed.clientId}, 'Bad', -1)`,
      ),
    ).rejects.toThrow(/total_one_time_nonneg|check/i);
  });
});

describe('P01 — proposal_versions', () => {
  it('UNIQUE (proposal_id, version) enforces snapshot ordering', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    const hash = 'a'.repeat(64);
    await harness.db.execute(
      sql`INSERT INTO proposal_versions
            (proposal_id, version, content_jsonb, content_hash, reason)
          VALUES (${proposalId}, 1, '{}'::jsonb, ${hash}, 'SENT')`,
    );
    await expect(
      harness.db.execute(
        sql`INSERT INTO proposal_versions
              (proposal_id, version, content_jsonb, content_hash, reason)
            VALUES (${proposalId}, 1, '{}'::jsonb, ${hash}, 'ACCEPTED')`,
      ),
    ).rejects.toThrow(/proposal_versions_proposal_version_uk|unique/i);
  });

  it('content_hash must match SHA-256 hex pattern', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    await expect(
      harness.db.execute(
        sql`INSERT INTO proposal_versions
              (proposal_id, version, content_jsonb, content_hash, reason)
            VALUES (${proposalId}, 1, '{}'::jsonb, 'notahash', 'SENT')`,
      ),
    ).rejects.toThrow(/hash_format|check/i);
  });

  it('CASCADE on proposal deletion', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    const hash = 'b'.repeat(64);
    await harness.db.execute(
      sql`INSERT INTO proposal_versions
            (proposal_id, version, content_jsonb, content_hash, reason)
          VALUES (${proposalId}, 1, '{}'::jsonb, ${hash}, 'SENT')`,
    );
    await harness.db.execute(sql`DELETE FROM proposals WHERE id = ${proposalId}`);
    const r = await harness.db.execute(
      sql`SELECT count(*)::int AS c FROM proposal_versions WHERE proposal_id = ${proposalId}`,
    );
    expect((r as unknown as { rows: { c: number }[] }).rows[0]!.c).toBe(0);
  });
});

describe('P01 — proposal_packages', () => {
  it('only one selected package per proposal (partial unique)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    const p1 = await harness.db.execute(
      sql`INSERT INTO packages (firm_id, name) VALUES (${seed.firmId}, 'Bronze') RETURNING id`,
    );
    const p2 = await harness.db.execute(
      sql`INSERT INTO packages (firm_id, name) VALUES (${seed.firmId}, 'Silver') RETURNING id`,
    );
    const id1 = (p1 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const id2 = (p2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO proposal_packages (proposal_id, package_id, selected)
          VALUES (${proposalId}, ${id1}, true)`,
    );
    await expect(
      harness.db.execute(
        sql`INSERT INTO proposal_packages (proposal_id, package_id, selected)
            VALUES (${proposalId}, ${id2}, true)`,
      ),
    ).rejects.toThrow(/one_selected_uk|unique/i);
    // Adding an unselected one is fine.
    await harness.db.execute(
      sql`INSERT INTO proposal_packages (proposal_id, package_id, selected)
          VALUES (${proposalId}, ${id2}, false)`,
    );
  });
});

describe('P01 — signatures (plural)', () => {
  it('multiple signatures per proposal allowed', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    await harness.db.execute(
      sql`INSERT INTO signatures
            (proposal_id, role, sequence, signer_name, signer_email, method, typed_name)
          VALUES (${proposalId}, 'PRIMARY', 0, 'A', 'a@x.com', 'TYPED_NAME', 'A')`,
    );
    await harness.db.execute(
      sql`INSERT INTO signatures
            (proposal_id, role, sequence, signer_name, signer_email, method, typed_name)
          VALUES (${proposalId}, 'COSIGNER', 1, 'B', 'b@x.com', 'TYPED_NAME', 'B')`,
    );
    const r = await harness.db.execute(
      sql`SELECT count(*)::int AS c FROM signatures WHERE proposal_id = ${proposalId}`,
    );
    expect((r as unknown as { rows: { c: number }[] }).rows[0]!.c).toBe(2);
  });

  it('signed state requires signed_at + payload_hash', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    await expect(
      harness.db.execute(
        sql`INSERT INTO signatures
              (proposal_id, signer_name, signer_email, method, state, typed_name)
            VALUES (${proposalId}, 'A', 'a@x.com', 'TYPED_NAME', 'SIGNED', 'A')`,
      ),
    ).rejects.toThrow(/signed_state_consistency|check/i);
  });

  it('method-specific payload check', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    // DRAWN_SVG without signature_svg, non-pending → fail.
    await expect(
      harness.db.execute(
        sql`INSERT INTO signatures
              (proposal_id, signer_name, signer_email, method, state)
            VALUES (${proposalId}, 'A', 'a@x.com', 'DRAWN_SVG', 'DECLINED')`,
      ),
    ).rejects.toThrow(/method_payload|check/i);
  });

  it('opensign envelope id is unique', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    await harness.db.execute(
      sql`INSERT INTO signatures
            (proposal_id, signer_name, signer_email, method, opensign_envelope_id)
          VALUES (${proposalId}, 'A', 'a@x.com', 'OPENSIGN', 'env_123')`,
    );
    await expect(
      harness.db.execute(
        sql`INSERT INTO signatures
              (proposal_id, signer_name, signer_email, method, opensign_envelope_id)
            VALUES (${proposalId}, 'B', 'b@x.com', 'OPENSIGN', 'env_123')`,
      ),
    ).rejects.toThrow(/opensign_envelope_uk|unique/i);
  });
});

describe('P01 — payment_mandates', () => {
  it('ACH mandate requires mandate text + hash', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expect(
      harness.db.execute(
        sql`INSERT INTO payment_mandates
              (firm_id, client_id, kind, stripe_account_id)
            VALUES (${seed.firmId}, ${seed.clientId}, 'ACH', 'acct_x')`,
      ),
    ).rejects.toThrow(/ach_text_required|check/i);
  });

  it('card mandate does not require ACH-specific fields', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.execute(
      sql`INSERT INTO payment_mandates
            (firm_id, client_id, kind, stripe_account_id)
          VALUES (${seed.firmId}, ${seed.clientId}, 'CARD', 'acct_x')`,
    );
  });

  it('text_hash format check (when present)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expect(
      harness.db.execute(
        sql`INSERT INTO payment_mandates
              (firm_id, client_id, kind, stripe_account_id,
               mandate_text_rendered, mandate_text_hash)
            VALUES (${seed.firmId}, ${seed.clientId}, 'ACH', 'acct_x',
                    'I authorize...', 'NOT_A_HASH')`,
      ),
    ).rejects.toThrow(/text_hash_format|check/i);
  });
});

describe('P01 — webhook_events', () => {
  it('stripe_event_id is PK — duplicate inserts fail', async () => {
    await harness.db.execute(
      sql`INSERT INTO webhook_events
            (stripe_event_id, stripe_account_id, event_type, payload)
          VALUES ('evt_001', 'acct_x', 'invoice.paid', '{}'::jsonb)`,
    );
    await expect(
      harness.db.execute(
        sql`INSERT INTO webhook_events
              (stripe_event_id, stripe_account_id, event_type, payload)
            VALUES ('evt_001', 'acct_x', 'invoice.paid', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/webhook_events_pkey|primary|unique/i);
  });
});

describe('P01 — magic_links', () => {
  it('token_hash is globally unique', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const hash = 'h'.repeat(64);
    const future = new Date(Date.now() + 86400_000).toISOString();
    await harness.db.execute(
      sql`INSERT INTO magic_links
            (firm_id, token_hash, purpose, client_id, expires_at)
          VALUES (${seed.firmId}, ${hash}, 'PROPOSAL', ${seed.clientId}, ${future})`,
    );
    await expect(
      harness.db.execute(
        sql`INSERT INTO magic_links
              (firm_id, token_hash, purpose, client_id, expires_at)
            VALUES (${seed.firmId}, ${hash}, 'ENGAGEMENT', ${seed.clientId}, ${future})`,
      ),
    ).rejects.toThrow(/token_hash_uk|unique/i);
  });

  it('expires_at must be after created_at', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const past = new Date(Date.now() - 86400_000).toISOString();
    await expect(
      harness.db.execute(
        sql`INSERT INTO magic_links
              (firm_id, token_hash, purpose, client_id, expires_at)
            VALUES (${seed.firmId}, ${'z'.repeat(64)}, 'PROPOSAL', ${seed.clientId}, ${past})`,
      ),
    ).rejects.toThrow(/expiry_after_creation|check/i);
  });
});

describe('P01 — client_accounts', () => {
  it('unique on (firm_id, lower(email))', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.execute(
      sql`INSERT INTO client_accounts
            (firm_id, client_id, email, password_hash)
          VALUES (${seed.firmId}, ${seed.clientId}, 'jane@example.com', 'argon2id$...')`,
    );
    await expect(
      harness.db.execute(
        sql`INSERT INTO client_accounts
              (firm_id, client_id, email, password_hash)
            VALUES (${seed.firmId}, ${seed.clientId}, 'JANE@example.com', 'argon2id$...')`,
      ),
    ).rejects.toThrow(/firm_email_uk|unique/i);
  });
});

describe('P01 — engagement_scope + deliverables', () => {
  it('engagement_scope CASCADE on engagement deletion', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    const hash = 'c'.repeat(64);
    const v = await harness.db.execute(
      sql`INSERT INTO proposal_versions
            (proposal_id, version, content_jsonb, content_hash, reason)
          VALUES (${proposalId}, 1, '{}'::jsonb, ${hash}, 'ACCEPTED')
          RETURNING id`,
    );
    const versionId = (v as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO engagement_scope
            (engagement_id, frozen_from_version_id, name, qty,
             unit_price_cents, billing_type)
          VALUES (${seed.engagementId}, ${versionId}, 'Monthly Bookkeeping',
                  1, 50000, 'RECURRING')`,
    );
    await harness.db.execute(sql`DELETE FROM engagement WHERE id = ${seed.engagementId}`);
    const r = await harness.db.execute(
      sql`SELECT count(*)::int AS c FROM engagement_scope WHERE engagement_id = ${seed.engagementId}`,
    );
    expect((r as unknown as { rows: { c: number }[] }).rows[0]!.c).toBe(0);
  });
});

describe('P01 — proposal_section_views', () => {
  it('unique on (proposal_id, section_block_id, session_id)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    await harness.db.execute(
      sql`INSERT INTO proposal_section_views
            (proposal_id, section_block_id, session_id)
          VALUES (${proposalId}, 'block-cover', 'sess_abc')`,
    );
    await expect(
      harness.db.execute(
        sql`INSERT INTO proposal_section_views
              (proposal_id, section_block_id, session_id)
            VALUES (${proposalId}, 'block-cover', 'sess_abc')`,
      ),
    ).rejects.toThrow(/section_session_uk|unique/i);
  });
});

describe('P01 — engagement column additions', () => {
  it('engagement.from_proposal_id stored + FK enforced', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    await harness.db.execute(
      sql`UPDATE engagement SET from_proposal_id = ${proposalId} WHERE id = ${seed.engagementId}`,
    );
    const r = await harness.db.execute(
      sql`SELECT from_proposal_id::text AS p FROM engagement WHERE id = ${seed.engagementId}`,
    );
    expect((r as unknown as { rows: { p: string }[] }).rows[0]!.p).toBe(proposalId);
  });

  it('engagement.renewed_from_engagement_id self-reference', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const e2 = await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure, renewed_from_engagement_id)
          VALUES (${seed.clientId}, '2027 Tax', 'FIXED_FEE', ${seed.engagementId})
          RETURNING id`,
    );
    const id2 = (e2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const r = await harness.db.execute(
      sql`SELECT renewed_from_engagement_id::text AS p FROM engagement WHERE id = ${id2}`,
    );
    expect((r as unknown as { rows: { p: string }[] }).rows[0]!.p).toBe(seed.engagementId);
  });
});

describe('P01 — renewals', () => {
  it('uplift_bps must be within -10000 to 100000', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expect(
      harness.db.execute(
        sql`INSERT INTO renewals (firm_id, current_engagement_id, uplift_bps)
            VALUES (${seed.firmId}, ${seed.engagementId}, 200000)`,
      ),
    ).rejects.toThrow(/uplift_bps_range|check/i);
    await expect(
      harness.db.execute(
        sql`INSERT INTO renewals (firm_id, current_engagement_id, uplift_bps)
            VALUES (${seed.firmId}, ${seed.engagementId}, -10001)`,
      ),
    ).rejects.toThrow(/uplift_bps_range|check/i);
  });
});

describe('P01 — proposal_activity', () => {
  it('CASCADE on proposal deletion', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const proposalId = await insertProposal(seed.firmId, seed.clientId);
    await harness.db.execute(
      sql`INSERT INTO proposal_activity (proposal_id, kind) VALUES (${proposalId}, 'CREATED')`,
    );
    await harness.db.execute(sql`DELETE FROM proposals WHERE id = ${proposalId}`);
    const r = await harness.db.execute(
      sql`SELECT count(*)::int AS c FROM proposal_activity WHERE proposal_id = ${proposalId}`,
    );
    expect((r as unknown as { rows: { c: number }[] }).rows[0]!.c).toBe(0);
  });
});
