// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0103 — MFK-envelope column crypto for intake records. Each intake
// session/link carries a per-record DEK (random key) wrapped by the firm
// MFK; the record's *_enc columns are encrypted with that DEK. Mirrors the
// messaging per-record-DEK pattern. Anonymous clients hold no key — this
// is encryption-at-rest, not E2EE.

import { generateKey, encrypt, decrypt } from '@vibe/crypto';
import type { Database } from '@vibe/db';

import { getFirmKeyManager } from '../crypto/manager';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromBytes = (b: Uint8Array): string => new TextDecoder('utf-8').decode(b);

export interface IntakeRecordKey {
  /** Plaintext per-record data key (in-memory only). */
  dek: Uint8Array;
  /** The DEK wrapped by the firm MFK — store this in the row. */
  wrappedDek: Uint8Array;
}

/** Mint a fresh per-record DEK wrapped by the firm MFK. */
export function newIntakeRecordKey(db: Database, firmId: string): IntakeRecordKey {
  const dek = generateKey();
  const wrappedDek = getFirmKeyManager(db).wrapTDek(firmId, dek);
  return { dek, wrappedDek };
}

/** Recover a record's DEK from its wrapped form. */
export function unwrapIntakeRecordKey(
  db: Database,
  firmId: string,
  wrappedDek: Uint8Array,
): Uint8Array {
  return getFirmKeyManager(db).unwrapTDek(firmId, wrappedDek);
}

/** Encrypt a column value with the record DEK (null passes through). */
export function encField(dek: Uint8Array, value: string | null | undefined): Buffer | null {
  if (value == null) return null;
  return Buffer.from(encrypt(utf8(value), dek).bytes);
}

/** Decrypt a column value with the record DEK (null passes through). */
export function decField(dek: Uint8Array, ct: Uint8Array | null | undefined): string | null {
  if (ct == null) return null;
  return fromBytes(decrypt(ct, dek));
}
