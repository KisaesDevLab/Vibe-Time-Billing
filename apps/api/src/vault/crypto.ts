// SPDX-License-Identifier: Elastic-2.0
//
// 0159 — MFK-envelope column crypto for the per-client credential vault. Each
// credential carries a per-record DEK (random key) wrapped by the firm MFK;
// the row's *_enc columns are encrypted with that DEK. Mirrors the intake /
// messaging per-record-DEK pattern. Encryption-at-rest, not E2EE — the firm
// (appliance) holds the key, so staff can reveal after a step-up.

import { generateKey, encrypt, decrypt } from '@vibe/crypto';
import type { Database } from '@vibe/db';

import { getFirmKeyManager } from '../crypto/manager';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromBytes = (b: Uint8Array): string => new TextDecoder('utf-8').decode(b);

export interface CredentialRecordKey {
  /** Plaintext per-record data key (in-memory only). */
  dek: Uint8Array;
  /** The DEK wrapped by the firm MFK — store this in the row. */
  wrappedDek: Uint8Array;
}

/** Mint a fresh per-credential DEK wrapped by the firm MFK. */
export function newCredentialKey(db: Database, firmId: string): CredentialRecordKey {
  const dek = generateKey();
  const wrappedDek = getFirmKeyManager(db).wrapTDek(firmId, dek);
  return { dek, wrappedDek };
}

/** Recover a credential's DEK from its wrapped form. */
export function unwrapCredentialKey(
  db: Database,
  firmId: string,
  wrappedDek: Uint8Array,
): Uint8Array {
  return getFirmKeyManager(db).unwrapTDek(firmId, wrappedDek);
}

/** Encrypt a column value with the credential DEK (null passes through). */
export function encField(dek: Uint8Array, value: string | null | undefined): Buffer | null {
  if (value == null || value === '') return null;
  return Buffer.from(encrypt(utf8(value), dek).bytes);
}

/** Decrypt a column value with the credential DEK (null passes through). */
export function decField(dek: Uint8Array, ct: Uint8Array | null | undefined): string | null {
  if (ct == null) return null;
  return fromBytes(decrypt(ct, dek));
}
