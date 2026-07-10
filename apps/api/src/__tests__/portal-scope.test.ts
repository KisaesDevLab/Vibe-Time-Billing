// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP7 — Multi-entity scope filter tests.
//
// Pinned properties:
//   1. Default (no ?scope) → only session.activeClientId
//   2. ?scope=all_accessible → every client with ACTIVE clientPortalAccess
//   3. Revoked / invited / archived access rows do NOT widen scope
//   4. The active client is always present even if its access row is
//      mid-transition (defensive).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resolveScope } from '../portal/scope';
import type { PortalSession } from '@vibe/core/auth';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

function mkReq(scope?: string): { query: Record<string, string> } {
  return { query: scope ? { scope } : {} };
}

function mkSession(portalIdentityId: string, activeClientId: string): PortalSession {
  return {
    realm: 'portal',
    sid: 'test-sid',
    portalIdentityId,
    firmId: 'firm-x',
    activeClientId,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    csrfToken: 'csrf-x',
    ip: null,
    userAgent: null,
  };
}

async function setupFixture(): Promise<{
  identityId: string;
  clientAId: string;
  clientBId: string;
  clientCId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const id = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'Multi User', 'multi@test.example') RETURNING id`,
  );
  const identityId = (id as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const c2 = await harness.db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
        VALUES (${seed.firmId}, 'Client B', ${seed.appUserId},
                (SELECT id FROM office WHERE firm_id = ${seed.firmId} ORDER BY is_default DESC LIMIT 1)) RETURNING id`,
  );
  const clientBId = (c2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const c3 = await harness.db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
        VALUES (${seed.firmId}, 'Client C (inactive)', ${seed.appUserId},
                (SELECT id FROM office WHERE firm_id = ${seed.firmId} ORDER BY is_default DESC LIMIT 1)) RETURNING id`,
  );
  const clientCId = (c3 as unknown as { rows: { id: string }[] }).rows[0]!.id;
  // Active accesses to A + B; revoked access to C.
  await harness.db.execute(
    sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status)
        VALUES (${identityId}, ${seed.clientId}, 'ACTIVE'),
               (${identityId}, ${clientBId}, 'ACTIVE'),
               (${identityId}, ${clientCId}, 'INACTIVE')`,
  );
  return {
    identityId,
    clientAId: seed.clientId,
    clientBId,
    clientCId,
  };
}

describe('resolveScope', () => {
  it('default returns only the active client', async () => {
    const f = await setupFixture();
    const result = await resolveScope(
      harness.db,
      mkSession(f.identityId, f.clientAId),
      mkReq() as never,
    );
    expect(result.clientIds).toEqual([f.clientAId]);
    expect(result.isConsolidated).toBe(false);
  });

  it('?scope=all_accessible returns every ACTIVE client', async () => {
    const f = await setupFixture();
    const result = await resolveScope(
      harness.db,
      mkSession(f.identityId, f.clientAId),
      mkReq('all_accessible') as never,
    );
    expect(result.clientIds.sort()).toEqual([f.clientAId, f.clientBId].sort());
    expect(result.isConsolidated).toBe(true);
  });

  it('inactive access rows do NOT widen the scope', async () => {
    const f = await setupFixture();
    const result = await resolveScope(
      harness.db,
      mkSession(f.identityId, f.clientAId),
      mkReq('all_accessible') as never,
    );
    expect(result.clientIds).not.toContain(f.clientCId);
  });

  it('always includes the active client even if access row is missing', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const id = await harness.db.execute(
      sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
          VALUES (${seed.firmId}, 'No-Access User', 'noaccess@test.example') RETURNING id`,
    );
    const identityId = (id as unknown as { rows: { id: string }[] }).rows[0]!.id;
    // No client_portal_access rows. resolveScope should still include
    // session.activeClientId via the defensive fallback.
    const result = await resolveScope(
      harness.db,
      mkSession(identityId, seed.clientId),
      mkReq('all_accessible') as never,
    );
    expect(result.clientIds).toContain(seed.clientId);
  });

  it('isConsolidated=false when only the active client is accessible', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const id = await harness.db.execute(
      sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
          VALUES (${seed.firmId}, 'Single User', 'single@test.example') RETURNING id`,
    );
    const identityId = (id as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status)
          VALUES (${identityId}, ${seed.clientId}, 'ACTIVE')`,
    );
    const result = await resolveScope(
      harness.db,
      mkSession(identityId, seed.clientId),
      mkReq('all_accessible') as never,
    );
    expect(result.clientIds).toEqual([seed.clientId]);
    expect(result.isConsolidated).toBe(false);
  });
});
