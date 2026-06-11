// SPDX-License-Identifier: Elastic-2.0
//
// TR-6 — Share helper + portal share-API tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { taxReturnReleases, taxReturnSections, taxReturns, taxReturnShares } from '@vibe/db/schema';
import { createShare, revokeShare, markExpiredShares } from '../tax-returns/share-helper';
import { verifyPassword } from '@vibe/crypto';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function setup(scope: 'FULL' | 'SELECTED' = 'FULL'): Promise<{
  firmId: string;
  clientId: string;
  appUserId: string;
  returnId: string;
  releaseId: string;
  sectionIds: string[];
  accessId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const [r] = await harness.db
    .insert(taxReturns)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      taxYear: 2025,
      formCode: '1120-S',
      title: '2025 S-Corp',
      status: 'RELEASED',
      totalPages: 14,
    })
    .returning();
  const s1 = await harness.db
    .insert(taxReturnSections)
    .values({
      returnId: r!.id,
      ordinal: 0,
      rawTitle: 'Form 1120-S',
      normalizedTitle: 'Form 1120-S',
      kind: 'MAIN_FORM',
      startPage: 1,
      endPage: 5,
    })
    .returning({ id: taxReturnSections.id });
  const s2 = await harness.db
    .insert(taxReturnSections)
    .values({
      returnId: r!.id,
      ordinal: 1,
      rawTitle: 'Schedule L',
      normalizedTitle: 'Schedule L',
      kind: 'SCHEDULE',
      startPage: 10,
      endPage: 10,
    })
    .returning({ id: taxReturnSections.id });
  const sectionIds = [s1[0]!.id, s2[0]!.id];
  const [rel] = await harness.db
    .insert(taxReturnReleases)
    .values({
      returnId: r!.id,
      releasedToClientId: seed.clientId,
      scope,
      sectionIds: scope === 'FULL' ? [] : [sectionIds[0]!],
      releasedByUserId: seed.appUserId,
    })
    .returning({ id: taxReturnReleases.id });
  const identity = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'Client', 'c@x.example') RETURNING id`,
  );
  const identityId = (identity as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const access = await harness.db.execute(
    sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status, role)
        VALUES (${identityId}, ${seed.clientId}, 'ACTIVE', 'FULL') RETURNING id`,
  );
  const accessId = (access as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return {
    firmId: seed.firmId,
    clientId: seed.clientId,
    appUserId: seed.appUserId,
    returnId: r!.id,
    releaseId: rel!.id,
    sectionIds,
    accessId,
  };
}

function tomorrow(): Date {
  return new Date(Date.now() + 24 * 60 * 60 * 1000);
}

describe('TR-6 — createShare', () => {
  it('issues a token + hash + row, plaintext only in result', async () => {
    const f = await setup();
    const result = await createShare({
      db: harness.db,
      returnId: f.returnId,
      sharedByAccessId: f.accessId,
      callerClientIds: [f.clientId],
      recipientName: 'Banker',
      recipientEmail: 'banker@chase.example',
      recipientPhone: null,
      organization: 'Chase',
      role: 'lender',
      accessLevel: 'view_only',
      scope: 'FULL',
      sectionIds: [],
      expiresAt: tomorrow(),
      require2fa: true,
      verifyChannel: 'EMAIL',
      watermark: true,
      personalMessage: '',
    });
    // Token format: <uuid>.<secret>. The secret part is what's
    // argon2-hashed in token_hash.
    expect(result.token).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/);
    expect(result.shareId).toBeTruthy();
    const [row] = await harness.db
      .select()
      .from(taxReturnShares)
      .where(eq(taxReturnShares.id, result.shareId));
    expect(row!.tokenHash.startsWith('$argon2id$')).toBe(true);
    // Verify the secret part matches the stored hash (constant-time).
    const secret = result.token.slice(result.token.indexOf('.') + 1);
    expect(await verifyPassword(row!.tokenHash, secret)).toBe(true);
    expect(row!.recipientEmail).toBe('banker@chase.example');
  });

  it('rejects a FULL-scope share when the release is SELECTED (partial)', async () => {
    const f = await setup('SELECTED');
    await expect(
      createShare({
        db: harness.db,
        returnId: f.returnId,
        sharedByAccessId: f.accessId,
        callerClientIds: [f.clientId],
        recipientName: 'Banker',
        recipientEmail: 'banker@chase.example',
        recipientPhone: null,
        organization: 'Chase',
        role: 'lender',
        accessLevel: 'view_only',
        scope: 'FULL',
        sectionIds: [],
        expiresAt: tomorrow(),
        require2fa: false,
        verifyChannel: 'NONE',
        watermark: true,
        personalMessage: '',
      }),
    ).rejects.toThrow(/scope_exceeds_release/);
  });

  it('rejects SELECTED section that is outside the release scope', async () => {
    const f = await setup('SELECTED');
    // Release only contains sectionIds[0]; try to share sectionIds[1].
    await expect(
      createShare({
        db: harness.db,
        returnId: f.returnId,
        sharedByAccessId: f.accessId,
        callerClientIds: [f.clientId],
        recipientName: 'X',
        recipientEmail: 'x@y.example',
        recipientPhone: null,
        organization: '',
        role: 'lender',
        accessLevel: 'view_only',
        scope: 'SELECTED',
        sectionIds: [f.sectionIds[1]!],
        expiresAt: tomorrow(),
        require2fa: false,
        verifyChannel: 'NONE',
        watermark: true,
        personalMessage: '',
      }),
    ).rejects.toThrow(/section_outside_release/);
  });

  it('caps expiry at 90 days', async () => {
    const f = await setup();
    const far = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const result = await createShare({
      db: harness.db,
      returnId: f.returnId,
      sharedByAccessId: f.accessId,
      callerClientIds: [f.clientId],
      recipientName: 'X',
      recipientEmail: 'x@y.example',
      recipientPhone: null,
      organization: '',
      role: 'lender',
      accessLevel: 'view_only',
      scope: 'FULL',
      sectionIds: [],
      expiresAt: far,
      require2fa: false,
      verifyChannel: 'NONE',
      watermark: true,
      personalMessage: '',
    });
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const delta = result.expiresAt.getTime() - Date.now();
    expect(delta).toBeLessThanOrEqual(ninetyDaysMs + 1000);
    expect(delta).toBeGreaterThan(ninetyDaysMs - 1000);
  });

  it('rejects past-expiry', async () => {
    const f = await setup();
    await expect(
      createShare({
        db: harness.db,
        returnId: f.returnId,
        sharedByAccessId: f.accessId,
        callerClientIds: [f.clientId],
        recipientName: 'X',
        recipientEmail: 'x@y.example',
        recipientPhone: null,
        organization: '',
        role: 'lender',
        accessLevel: 'view_only',
        scope: 'FULL',
        sectionIds: [],
        expiresAt: new Date(Date.now() - 1000),
        require2fa: false,
        verifyChannel: 'NONE',
        watermark: true,
        personalMessage: '',
      }),
    ).rejects.toThrow(/expiry_in_past/);
  });

  it('rejects when caller has no live release for the return', async () => {
    const f = await setup();
    await harness.db.execute(
      sql`UPDATE tax_return_releases SET revoked_at = NOW() WHERE id = ${f.releaseId}`,
    );
    await expect(
      createShare({
        db: harness.db,
        returnId: f.returnId,
        sharedByAccessId: f.accessId,
        callerClientIds: [f.clientId],
        recipientName: 'X',
        recipientEmail: 'x@y.example',
        recipientPhone: null,
        organization: '',
        role: 'lender',
        accessLevel: 'view_only',
        scope: 'FULL',
        sectionIds: [],
        expiresAt: tomorrow(),
        require2fa: false,
        verifyChannel: 'NONE',
        watermark: true,
        personalMessage: '',
      }),
    ).rejects.toThrow(/release_not_found/);
  });
});

describe('TR-6 — rate limits', () => {
  // These tests insert raw rows to push past thresholds quickly,
  // bypassing the 50 sequential createShare calls that would otherwise
  // take ~30 seconds with Argon2id hashing.
  it('429-equivalent when >=10 ACTIVE on return for this access', async () => {
    const f = await setup();
    // Pre-seed 10 active shares.
    for (let i = 0; i < 10; i++) {
      await harness.db.execute(
        sql`INSERT INTO tax_return_shares
              (return_id, release_id, shared_by_access_id, recipient_name,
               recipient_email, role, scope, token_hash, expires_at, status)
            VALUES
              (${f.returnId}, ${f.releaseId}, ${f.accessId}, ${'R' + i},
               ${'r' + i + '@y.example'}, 'lender', 'FULL',
               ${`$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAA$unique${i}aaaaaaaaaaaaaaaaaaaaaaaa`},
               NOW() + INTERVAL '1 day', 'SENT')`,
      );
    }
    await expect(
      createShare({
        db: harness.db,
        returnId: f.returnId,
        sharedByAccessId: f.accessId,
        callerClientIds: [f.clientId],
        recipientName: 'X',
        recipientEmail: 'overflow@y.example',
        recipientPhone: null,
        organization: '',
        role: 'lender',
        accessLevel: 'view_only',
        scope: 'FULL',
        sectionIds: [],
        expiresAt: tomorrow(),
        require2fa: false,
        verifyChannel: 'NONE',
        watermark: true,
        personalMessage: '',
      }),
    ).rejects.toThrow(/rate_limit_active_per_return/);
  });

  it('blocks >=5 ACTIVE for same recipient email across firms', async () => {
    const f = await setup();
    for (let i = 0; i < 5; i++) {
      await harness.db.execute(
        sql`INSERT INTO tax_return_shares
              (return_id, release_id, shared_by_access_id, recipient_name,
               recipient_email, role, scope, token_hash, expires_at, status)
            VALUES
              (${f.returnId}, ${f.releaseId}, ${f.accessId}, 'R',
               'same@chase.example', 'lender', 'FULL',
               ${'$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAA$' + 'X'.repeat(i + 1)},
               NOW() + INTERVAL '1 day', 'SENT')`,
      );
    }
    await expect(
      createShare({
        db: harness.db,
        returnId: f.returnId,
        sharedByAccessId: f.accessId,
        callerClientIds: [f.clientId],
        recipientName: 'X',
        recipientEmail: 'same@chase.example',
        recipientPhone: null,
        organization: '',
        role: 'lender',
        accessLevel: 'view_only',
        scope: 'FULL',
        sectionIds: [],
        expiresAt: tomorrow(),
        require2fa: false,
        verifyChannel: 'NONE',
        watermark: true,
        personalMessage: '',
      }),
    ).rejects.toThrow(/rate_limit_recipient_email/);
  });
});

describe('TR-6 — revokeShare + markExpiredShares', () => {
  it('soft-revokes and is idempotent', async () => {
    const f = await setup();
    const created = await createShare({
      db: harness.db,
      returnId: f.returnId,
      sharedByAccessId: f.accessId,
      callerClientIds: [f.clientId],
      recipientName: 'X',
      recipientEmail: 'x@y.example',
      recipientPhone: null,
      organization: '',
      role: 'lender',
      accessLevel: 'view_only',
      scope: 'FULL',
      sectionIds: [],
      expiresAt: tomorrow(),
      require2fa: false,
      verifyChannel: 'NONE',
      watermark: true,
      personalMessage: '',
    });
    await revokeShare(harness.db, created.shareId, f.accessId, [f.clientId]);
    const [row] = await harness.db
      .select()
      .from(taxReturnShares)
      .where(eq(taxReturnShares.id, created.shareId));
    expect(row!.status).toBe('REVOKED');
    expect(row!.revokedAt).not.toBeNull();
  });

  it('rejects revoke from a different client', async () => {
    const f = await setup();
    const created = await createShare({
      db: harness.db,
      returnId: f.returnId,
      sharedByAccessId: f.accessId,
      callerClientIds: [f.clientId],
      recipientName: 'X',
      recipientEmail: 'x@y.example',
      recipientPhone: null,
      organization: '',
      role: 'lender',
      accessLevel: 'view_only',
      scope: 'FULL',
      sectionIds: [],
      expiresAt: tomorrow(),
      require2fa: false,
      verifyChannel: 'NONE',
      watermark: true,
      personalMessage: '',
    });
    await expect(
      revokeShare(harness.db, created.shareId, f.accessId, [
        '00000000-0000-4000-8000-000000000000',
      ]),
    ).rejects.toThrow(/forbidden/);
  });

  it('markExpiredShares flips past-expiry SENT rows to EXPIRED', async () => {
    const f = await setup();
    await harness.db.execute(
      sql`INSERT INTO tax_return_shares
            (return_id, release_id, shared_by_access_id, recipient_name,
             recipient_email, role, scope, token_hash, sent_at, expires_at, status)
          VALUES
            (${f.returnId}, ${f.releaseId}, ${f.accessId}, 'X',
             'old@y.example', 'lender', 'FULL',
             ${'$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAA$YYY'},
             NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 hour', 'SENT')`,
    );
    const flipped = await markExpiredShares(harness.db);
    expect(flipped).toBeGreaterThan(0);
    const [row] = await harness.db
      .select()
      .from(taxReturnShares)
      .where(eq(taxReturnShares.recipientEmail, 'old@y.example'));
    expect(row!.status).toBe('EXPIRED');
  });
});
