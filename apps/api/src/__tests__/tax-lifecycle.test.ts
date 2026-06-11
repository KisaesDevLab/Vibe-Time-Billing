// SPDX-License-Identifier: Elastic-2.0
//
// TR-9 — Lifecycle helper tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { taxReturnReleases, taxReturnSections, taxReturns } from '@vibe/db/schema';
import { findSharesExpiringWithin, planCacheWarmForRelease } from '../tax-returns/lifecycle';
import { markExpiredShares } from '../tax-returns/share-helper';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

let shareCounter = 0;

async function seedReturnWithReleaseAndShare(opts: { expiresInHours: number }): Promise<{
  firmId: string;
  returnId: string;
  releaseId: string;
  shareId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const [r] = await harness.db
    .insert(taxReturns)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      taxYear: 2025,
      formCode: '1040',
      title: 'T',
      totalPages: 5,
    })
    .returning();
  await harness.db.insert(taxReturnSections).values({
    returnId: r!.id,
    ordinal: 0,
    rawTitle: 'F1040',
    normalizedTitle: 'Form 1040',
    kind: 'MAIN_FORM',
    startPage: 1,
    endPage: 5,
  });
  const [rel] = await harness.db
    .insert(taxReturnReleases)
    .values({
      returnId: r!.id,
      releasedToClientId: seed.clientId,
      scope: 'FULL',
      releasedByUserId: seed.appUserId,
    })
    .returning({ id: taxReturnReleases.id });
  const identity = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'C', 'c@x.example') RETURNING id`,
  );
  const identityId = (identity as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const access = await harness.db.execute(
    sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status, role)
        VALUES (${identityId}, ${seed.clientId}, 'ACTIVE', 'FULL') RETURNING id`,
  );
  const accessId = (access as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const uniqueHash = `$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAA$share-${++shareCounter}-aaaaaaaaaaaaaaaaaaaa`;
  const shareRow = await harness.db.execute(
    sql`INSERT INTO tax_return_shares
          (return_id, release_id, shared_by_access_id, recipient_name,
           recipient_email, role, scope, token_hash, expires_at,
           verify_channel, status)
        VALUES
          (${r!.id}, ${rel!.id}, ${accessId}, 'B', ${`b${shareCounter}@y.example`},
           'lender', 'FULL', ${uniqueHash},
           NOW() + (${opts.expiresInHours} * INTERVAL '1 hour'),
           'EMAIL', 'SENT')
        RETURNING id`,
  );
  const shareId = (shareRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return {
    firmId: seed.firmId,
    returnId: r!.id,
    releaseId: rel!.id,
    shareId,
  };
}

describe('TR-9 — findSharesExpiringWithin', () => {
  it('returns shares expiring within the window', async () => {
    const f = await seedReturnWithReleaseAndShare({ expiresInHours: 24 });
    const list = await findSharesExpiringWithin(harness.db, 48, 'expiring_48h');
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(f.shareId);
    expect(list[0]!.recipientEmail).toContain('@y.example');
  });

  it('skips shares expiring outside the window', async () => {
    await seedReturnWithReleaseAndShare({ expiresInHours: 100 });
    const list = await findSharesExpiringWithin(harness.db, 48, 'expiring_48h');
    expect(list.length).toBe(0);
  });

  it('2h window catches a near-expiry but skips a 24h-out share', async () => {
    await seedReturnWithReleaseAndShare({ expiresInHours: 1 });
    await seedReturnWithReleaseAndShare({ expiresInHours: 24 });
    const list = await findSharesExpiringWithin(harness.db, 2, 'expiring_2h');
    expect(list.length).toBe(1);
  });
});

describe('TR-9 — planCacheWarmForRelease', () => {
  it('produces deterministic cache key for the release', async () => {
    const f = await seedReturnWithReleaseAndShare({ expiresInHours: 24 });
    const plan = await planCacheWarmForRelease(harness.db, f.releaseId);
    expect(plan).not.toBeNull();
    expect(plan!.releaseId).toBe(f.releaseId);
    expect(plan!.pageCount).toBe(5);
    expect(plan!.cacheKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns null for unknown release', async () => {
    const plan = await planCacheWarmForRelease(harness.db, '00000000-0000-4000-8000-000000000000');
    expect(plan).toBeNull();
  });
});

describe('TR-9 — markExpiredShares (cron)', () => {
  it('flips past-expiry SENT shares to EXPIRED', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [r] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 2025,
        formCode: '1040',
        title: 'T',
      })
      .returning();
    const [rel] = await harness.db
      .insert(taxReturnReleases)
      .values({
        returnId: r!.id,
        releasedToClientId: seed.clientId,
        scope: 'FULL',
        releasedByUserId: seed.appUserId,
      })
      .returning({ id: taxReturnReleases.id });
    const identity = await harness.db.execute(
      sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
          VALUES (${seed.firmId}, 'C', 'c@x.example') RETURNING id`,
    );
    const identityId = (identity as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const access = await harness.db.execute(
      sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status, role)
          VALUES (${identityId}, ${seed.clientId}, 'ACTIVE', 'FULL') RETURNING id`,
    );
    const accessId = (access as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO tax_return_shares
            (return_id, release_id, shared_by_access_id, recipient_name,
             recipient_email, role, scope, token_hash,
             sent_at, expires_at, status)
          VALUES
            (${r!.id}, ${rel!.id}, ${accessId}, 'B', 'b@y.example',
             'lender', 'FULL',
             ${'$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAA$ZZZZ'},
             NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day', 'SENT')`,
    );
    const flipped = await markExpiredShares(harness.db);
    expect(flipped).toBeGreaterThan(0);
  });
});
