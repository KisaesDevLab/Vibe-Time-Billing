// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// At-rest sealing for staff TOTP shared secrets.
//
// The TOTP secret is the long-lived seed that generates every code, so it
// must never sit in the database as plaintext — a single table read would
// let an attacker mint valid codes forever and defeat the second factor.
// We seal it with the same KMS_KEY AES-256-GCM envelope used for the
// messaging provider credentials (see packages/core/src/crypto/aes.ts).
//
// Backward compatibility: rows enrolled before sealing existed hold a raw
// base32 secret. Sealed values carry the "v1:" envelope prefix, which a
// base32 seed (uppercase A–Z / 2–7, no colons) can never start with — so
// `openTotpSecret` can tell them apart. Legacy plaintext is returned
// unchanged (existing users keep working); new enrollments are always
// sealed, and a legacy row is re-sealed lazily on its next successful
// verification.

import { crypto as core } from '@vibe/core';

import { loadConfig } from '../config';

const ENVELOPE_PREFIX = 'v1:';

export function isSealedTotpSecret(stored: string): boolean {
  return stored.startsWith(ENVELOPE_PREFIX);
}

export function sealTotpSecret(plain: string): string {
  const kms = loadConfig().KMS_KEY;
  // KMS_KEY is mandatory in production (config throws at boot without it);
  // only a misconfigured dev environment reaches here without one, in
  // which case we preserve the previous plaintext-store behavior.
  if (!kms) return plain;
  return core.encryptString(plain, core.resolveKey(kms));
}

export function openTotpSecret(stored: string): string {
  if (!isSealedTotpSecret(stored)) return stored; // legacy plaintext seed
  const kms = loadConfig().KMS_KEY;
  if (!kms) throw new Error('KMS_KEY is required to decrypt a sealed TOTP secret');
  return core.decryptString(stored, core.resolveKey(kms));
}
