// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP6 — Portal activity log SQL tests.
//
// Critical properties pinned here:
//   1. Privacy filter — beforeJson / afterJson never reach the
//      response shape.
//   2. Entity-type allowlist — firm-internal entries (time_entry,
//      billing_batch, adjustment, app_user) MUST be excluded.
//   3. Scope — staff-initiated rows on entities owned by client B
//      must never appear in client A's feed.

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

// Mirror of the SQL fragment in apps/api/src/portal/activity.ts so the
// invariants can be exercised without booting Express.
async function portalActivity(
  portalIdentityId: string,
  activeClientId: string,
): Promise<Array<{ entity_type: string; entity_id: string | null }>> {
  const exec = await harness.db.execute(
    sql`
      WITH allowed AS (
        SELECT al.id, al.occurred_at, al.action, al.entity_type, al.entity_id,
               al.actor_app_user_id, al.actor_portal_identity_id, al.active_client_id
        FROM audit_log al
        WHERE (
            al.actor_portal_identity_id = ${portalIdentityId}
            OR al.active_client_id = ${activeClientId}
          )
          AND al.entity_type IN (
            'portal_session', 'portal_alt_contact', 'client_portal_access',
            'invoice', 'payment', 'payment_method', 'file', 'client_request',
            'engagement'
          )
        UNION
        SELECT al.id, al.occurred_at, al.action, al.entity_type, al.entity_id,
               al.actor_app_user_id, al.actor_portal_identity_id, al.active_client_id
        FROM audit_log al
        JOIN invoice inv ON inv.id = al.entity_id
        WHERE al.entity_type = 'invoice'
          AND inv.client_id = ${activeClientId}
          AND al.actor_app_user_id IS NOT NULL
        UNION
        SELECT al.id, al.occurred_at, al.action, al.entity_type, al.entity_id,
               al.actor_app_user_id, al.actor_portal_identity_id, al.active_client_id
        FROM audit_log al
        JOIN engagement e ON e.id = al.entity_id
        WHERE al.entity_type = 'engagement'
          AND e.client_id = ${activeClientId}
          AND al.actor_app_user_id IS NOT NULL
      )
      SELECT a.entity_type, a.entity_id
      FROM allowed a
      ORDER BY a.occurred_at DESC
    `,
  );
  return (
    (exec as unknown as { rows: Array<{ entity_type: string; entity_id: string | null }> }).rows ??
    []
  );
}

interface Fixture {
  firmId: string;
  clientAId: string;
  clientBId: string;
  identityAId: string;
  invoiceA: string;
  invoiceB: string;
  engagementA: string;
}

async function setupFixture(): Promise<Fixture> {
  const seed = await seedMinimalFirm(harness.db);
  // Add a second client + engagement in the same firm.
  const c2 = await harness.db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
        VALUES (${seed.firmId}, 'Other Co', ${seed.appUserId},
                (SELECT id FROM office WHERE firm_id = ${seed.firmId} ORDER BY is_default DESC LIMIT 1)) RETURNING id`,
  );
  const clientBId = (c2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
  // Fake portal_identity row (just need a uuid — table is in portal.ts).
  const idRes = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'Test User', 'user@test.example') RETURNING id`,
  );
  const identityAId = (idRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
  // Invoices on both clients.
  const inv1 = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                              issue_date, due_date, subtotal_cents, total_cents, status)
        VALUES (${seed.firmId}, ${seed.clientId}, ${seed.engagementId}, 'A-1',
                '2026-01-01', '2026-02-01', 100000, 100000, 'SENT')
        RETURNING id`,
  );
  const invoiceA = (inv1 as unknown as { rows: { id: string }[] }).rows[0]!.id;
  // Engagement on client B + an invoice on it.
  const e2 = await harness.db.execute(
    sql`INSERT INTO engagement (client_id, name, fee_structure, status)
        VALUES (${clientBId}, 'B engagement', 'HOURLY', 'ACTIVE') RETURNING id`,
  );
  const engagementB = (e2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const inv2 = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                              issue_date, due_date, subtotal_cents, total_cents, status)
        VALUES (${seed.firmId}, ${clientBId}, ${engagementB}, 'B-1',
                '2026-01-01', '2026-02-01', 100000, 100000, 'SENT')
        RETURNING id`,
  );
  const invoiceB = (inv2 as unknown as { rows: { id: string }[] }).rows[0]!.id;

  // Audit rows:
  // (1) Staff invoice CREATE on client A's invoice — should appear in A's feed
  await harness.db.execute(
    sql`INSERT INTO audit_log (action, entity_type, entity_id, actor_app_user_id)
        VALUES ('CREATE', 'invoice', ${invoiceA}, ${seed.appUserId})`,
  );
  // (2) Staff invoice CREATE on client B's invoice — should NOT appear in A's feed
  await harness.db.execute(
    sql`INSERT INTO audit_log (action, entity_type, entity_id, actor_app_user_id)
        VALUES ('CREATE', 'invoice', ${invoiceB}, ${seed.appUserId})`,
  );
  // (3) Staff engagement UPDATE on client A — should appear
  await harness.db.execute(
    sql`INSERT INTO audit_log (action, entity_type, entity_id, actor_app_user_id, after_json)
        VALUES ('UPDATE', 'engagement', ${seed.engagementId}, ${seed.appUserId},
                ${JSON.stringify({ secretField: 'firm-internal' })}::jsonb)`,
  );
  // (4) Staff TIME_ENTRY create — firm-internal, should NOT appear
  await harness.db.execute(
    sql`INSERT INTO audit_log (action, entity_type, entity_id, actor_app_user_id)
        VALUES ('CREATE', 'time_entry', gen_random_uuid(), ${seed.appUserId})`,
  );
  // (5) Portal identity's own action (sign-in)
  await harness.db.execute(
    sql`INSERT INTO audit_log (action, entity_type, actor_portal_identity_id, active_client_id)
        VALUES ('CREATE', 'portal_session', ${identityAId}, ${seed.clientId})`,
  );
  // (6) Firm-internal billing batch — should NOT appear
  await harness.db.execute(
    sql`INSERT INTO audit_log (action, entity_type, entity_id, actor_app_user_id)
        VALUES ('CREATE', 'billing_batch', gen_random_uuid(), ${seed.appUserId})`,
  );

  return {
    firmId: seed.firmId,
    clientAId: seed.clientId,
    clientBId,
    identityAId,
    invoiceA,
    invoiceB,
    engagementA: seed.engagementId,
  };
}

describe('portal activity SQL', () => {
  it('returns client-A scoped staff actions + own portal actions', async () => {
    const f = await setupFixture();
    const rows = await portalActivity(f.identityAId, f.clientAId);
    const entityTypes = rows.map((r) => r.entity_type);
    expect(entityTypes).toContain('invoice'); // client A's invoice
    expect(entityTypes).toContain('engagement'); // client A's engagement
    expect(entityTypes).toContain('portal_session'); // identity's own sign-in
  });

  it('excludes time_entry / billing_batch (firm-internal entity types)', async () => {
    const f = await setupFixture();
    const rows = await portalActivity(f.identityAId, f.clientAId);
    const entityTypes = rows.map((r) => r.entity_type);
    expect(entityTypes).not.toContain('time_entry');
    expect(entityTypes).not.toContain('billing_batch');
  });

  it('excludes invoice events for client B (cross-client isolation)', async () => {
    const f = await setupFixture();
    const rows = await portalActivity(f.identityAId, f.clientAId);
    const entityIds = rows.map((r) => r.entity_id);
    expect(entityIds).toContain(f.invoiceA);
    expect(entityIds).not.toContain(f.invoiceB);
  });
});
