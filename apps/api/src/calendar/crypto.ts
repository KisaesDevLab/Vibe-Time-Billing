// SPDX-License-Identifier: Elastic-2.0
//
// CAL-1 — MFK-envelope column crypto for calendar secrets. Provider client
// secrets and per-staff OAuth access/refresh tokens are stored as bytea
// ciphertext under a per-row DEK wrapped by the firm MFK. Mirrors
// apps/api/src/intake/crypto.ts exactly — tokens never leave the row in
// plaintext and never appear in API responses or logs.

import { generateKey, encrypt, decrypt } from '@vibe/crypto';
import type { Database } from '@vibe/db';

import { getFirmKeyManager } from '../crypto/manager';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromBytes = (b: Uint8Array): string => new TextDecoder('utf-8').decode(b);

export interface CalendarRecordKey {
  /** Plaintext per-record data key (in-memory only). */
  dek: Uint8Array;
  /** The DEK wrapped by the firm MFK — store in the row's t_dek_wrapped. */
  wrappedDek: Uint8Array;
}

/** Mint a fresh per-record DEK wrapped by the firm MFK. */
export function newCalendarRecordKey(db: Database, firmId: string): CalendarRecordKey {
  const dek = generateKey();
  const wrappedDek = getFirmKeyManager(db).wrapTDek(firmId, dek);
  return { dek, wrappedDek };
}

/** Recover a record's DEK from its wrapped form. */
export function unwrapCalendarRecordKey(
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
