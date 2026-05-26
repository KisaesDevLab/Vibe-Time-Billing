// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-11 — DEK wrap/unwrap tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { taxReturnReleases, taxReturns } from '@vibe/db/schema';
import { generateKey, decrypt } from '@vibe/crypto';
import {
  DekError,
  ensureReturnDek,
  ensureShareDek,
  revokeShareDek,
  unwrapReturnDek,
  unwrapShareDek,
} from '../tax-returns/dek-wrap';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function seedReturn(): Promise<string> {
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
  return r!.id;
}

describe('TR-11 — ensureReturnDek', () => {
  it('mints + wraps a fresh DEK and persists it', async () => {
    const kek = generateKey();
    const returnId = await seedReturn();
    const dek1 = await ensureReturnDek(harness.db, returnId, kek);
    expect(dek1.length).toBe(32);
    // Round-trip: same call returns the same plaintext DEK.
    const dek2 = await ensureReturnDek(harness.db, returnId, kek);
    expect(Buffer.from(dek2)).toEqual(Buffer.from(dek1));
  });

  it('persists ciphertext, not plaintext', async () => {
    const kek = generateKey();
    const returnId = await seedReturn();
    const dek = await ensureReturnDek(harness.db, returnId, kek);
    const [row] = await harness.db
      .select({ wrappedDek: taxReturns.wrappedDek })
      .from(taxReturns)
      .where(eq(taxReturns.id, returnId));
    expect(row!.wrappedDek).not.toBeNull();
    // The stored blob is NOT the plaintext DEK.
    expect(Buffer.from(row!.wrappedDek!).equals(Buffer.from(dek))).toBe(false);
    // But it decrypts to the same DEK.
    const recovered = decrypt(new Uint8Array(row!.wrappedDek!), kek);
    expect(Buffer.from(recovered)).toEqual(Buffer.from(dek));
  });

  it('throws on wrong KEK', async () => {
    const kek1 = generateKey();
    const kek2 = generateKey();
    const returnId = await seedReturn();
    await ensureReturnDek(harness.db, returnId, kek1);
    await expect(unwrapReturnDek(harness.db, returnId, kek2)).rejects.toThrow();
  });

  it('unwrapReturnDek throws when no DEK', async () => {
    const kek = generateKey();
    const returnId = await seedReturn();
    await expect(unwrapReturnDek(harness.db, returnId, kek)).rejects.toThrow(DekError);
  });
});

describe('TR-11 — ensureShareDek', () => {
  async function seedShare(): Promise<string> {
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
    const share = await harness.db.execute(
      sql`INSERT INTO tax_return_shares
            (return_id, release_id, shared_by_access_id, recipient_name,
             recipient_email, role, scope, token_hash, expires_at, status)
          VALUES
            (${r!.id}, ${rel!.id}, ${accessId}, 'B', 'b@y.example',
             'lender', 'FULL',
             ${'$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAA$KKKK'},
             NOW() + INTERVAL '1 day', 'SENT')
          RETURNING id`,
    );
    return (share as unknown as { rows: { id: string }[] }).rows[0]!.id;
  }

  it('mints + persists a per-share DEK independent of the return DEK', async () => {
    const kek = generateKey();
    const shareId = await seedShare();
    const dek = await ensureShareDek(harness.db, shareId, kek);
    expect(dek.length).toBe(32);
    const dek2 = await unwrapShareDek(harness.db, shareId, kek);
    expect(Buffer.from(dek2)).toEqual(Buffer.from(dek));
  });

  it('revokeShareDek nulls out the column → unwrap throws', async () => {
    const kek = generateKey();
    const shareId = await seedShare();
    await ensureShareDek(harness.db, shareId, kek);
    await revokeShareDek(harness.db, shareId);
    await expect(unwrapShareDek(harness.db, shareId, kek)).rejects.toThrow(/no_dek/);
  });
});
