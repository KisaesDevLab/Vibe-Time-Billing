// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-11 — Per-return and per-share DEK wrapping.
//
// Each tax_returns row gets a fresh 32-byte DEK at first encryption.
// Each tax_return_shares row gets its own DEK so revocation is a
// key-deletion event: nulling wrapped_dek on a share renders any
// cached ciphertext un-decryptable, even if the recipient has the
// share's URL+token.
//
// The DEKs are wrapped (encrypted) under the firm's KEK (TR-1
// schema: tax_returns.wrapped_dek bytea). The KEK is sourced from
// the firm-key-manager which already exists from the proposal
// module's HMAC chain (P16) — same root of trust, different label.
//
// Helpers:
//   ensureReturnDek(db, returnId, kek) — get-or-create the wrapped
//     DEK for a return. Idempotent.
//   ensureShareDek(db, shareId, kek)   — same, for shares.
//   unwrapReturnDek(db, returnId, kek) — fetch the wrapped DEK,
//     decrypt to plaintext 32-byte key. Throws if missing or
//     corrupt.
//   unwrapShareDek(db, shareId, kek)
//   revokeShareDek(db, shareId)         — null out wrapped_dek to
//     make the share's bytes permanently un-decryptable.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { taxReturns, taxReturnShares } from '@vibe/db/schema';
import { decrypt, encrypt, generateKey } from '@vibe/crypto';

export class DekError extends Error {
  constructor(
    public code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'DekError';
  }
}

export async function ensureReturnDek(
  db: Database,
  returnId: string,
  kek: Uint8Array,
): Promise<Uint8Array> {
  const [row] = await db
    .select({ wrappedDek: taxReturns.wrappedDek })
    .from(taxReturns)
    .where(eq(taxReturns.id, returnId))
    .limit(1);
  if (!row) throw new DekError('return_not_found', returnId);
  if (row.wrappedDek) {
    return decrypt(new Uint8Array(row.wrappedDek), kek);
  }
  const dek = generateKey();
  const wrapped = encrypt(dek, kek).bytes;
  await db
    .update(taxReturns)
    .set({ wrappedDek: Buffer.from(wrapped) })
    .where(eq(taxReturns.id, returnId));
  return dek;
}

export async function unwrapReturnDek(
  db: Database,
  returnId: string,
  kek: Uint8Array,
): Promise<Uint8Array> {
  const [row] = await db
    .select({ wrappedDek: taxReturns.wrappedDek })
    .from(taxReturns)
    .where(eq(taxReturns.id, returnId))
    .limit(1);
  if (!row || !row.wrappedDek) throw new DekError('no_dek', returnId);
  return decrypt(new Uint8Array(row.wrappedDek), kek);
}

export async function ensureShareDek(
  db: Database,
  shareId: string,
  kek: Uint8Array,
): Promise<Uint8Array> {
  const [row] = await db
    .select({ wrappedDek: taxReturnShares.wrappedDek })
    .from(taxReturnShares)
    .where(eq(taxReturnShares.id, shareId))
    .limit(1);
  if (!row) throw new DekError('share_not_found', shareId);
  if (row.wrappedDek) {
    return decrypt(new Uint8Array(row.wrappedDek), kek);
  }
  const dek = generateKey();
  const wrapped = encrypt(dek, kek).bytes;
  await db
    .update(taxReturnShares)
    .set({ wrappedDek: Buffer.from(wrapped) })
    .where(eq(taxReturnShares.id, shareId));
  return dek;
}

export async function unwrapShareDek(
  db: Database,
  shareId: string,
  kek: Uint8Array,
): Promise<Uint8Array> {
  const [row] = await db
    .select({ wrappedDek: taxReturnShares.wrappedDek })
    .from(taxReturnShares)
    .where(eq(taxReturnShares.id, shareId))
    .limit(1);
  if (!row || !row.wrappedDek) throw new DekError('no_dek', shareId);
  return decrypt(new Uint8Array(row.wrappedDek), kek);
}

// Revoke = null out the wrapped DEK. Any cached ciphertext signed
// with this share's DEK is now permanently un-decryptable.
export async function revokeShareDek(db: Database, shareId: string): Promise<void> {
  await db.update(taxReturnShares).set({ wrappedDek: null }).where(eq(taxReturnShares.id, shareId));
}
