// SPDX-License-Identifier: Elastic-2.0
//
// Connect I.4 — server-peppered HMAC of a client's tax id, used as
// the knowledge factor for the ssn-last-4 / ein step-up challenges.
//
// Storage shape (client.tax_id_kind + client.tax_id_hash):
//   tax_id_kind = 'ssn_last4'  — hash of the SSN's last 4 digits
//   tax_id_kind = 'ein'        — hash of the full 9-digit EIN
//
// hashTaxId returns a base64url-encoded HMAC-SHA-256 over the
// normalized digits keyed by the TAX_ID_HASH_PEPPER env value. The
// pepper is mandatory; rotating it invalidates every stored hash so
// firms must re-enroll affected clients. We never write the raw value
// to logs (including pino), and the helpers return Result-shaped
// errors instead of throwing on length-mismatch so callers can map
// them to clean 400s.

import { createHmac, timingSafeEqual } from 'node:crypto';

export type TaxIdKind = 'ssn_last4' | 'ein';

export function isFeatureEnabled(): boolean {
  const pepper = process.env['TAX_ID_HASH_PEPPER'];
  return typeof pepper === 'string' && pepper.length >= 16;
}

function loadPepper(): string {
  const pepper = process.env['TAX_ID_HASH_PEPPER'];
  if (!pepper || pepper.length < 16) {
    throw new Error('tax_id_pepper_not_configured');
  }
  return pepper;
}

/** Strip every non-digit character. Used to normalize "123-45-6789"
 *  and "  123-45-6789  " into a stable input before hashing. */
function digitsOnly(input: string): string {
  return input.replace(/\D+/g, '');
}

export interface NormalizeOk {
  ok: true;
  digits: string;
}
export interface NormalizeErr {
  ok: false;
  error: 'wrong_length' | 'non_digit';
}
export type NormalizeResult = NormalizeOk | NormalizeErr;

/**
 * Normalize a raw user-entered tax-id value for the given kind.
 * SSN last-4 must be exactly 4 digits. EIN must be exactly 9 digits.
 * Returns the digit-only string on success, never the raw input.
 */
export function normalizeTaxId(kind: TaxIdKind, raw: string): NormalizeResult {
  const digits = digitsOnly(raw);
  if (digits.length !== raw.replace(/[\s-]/g, '').length) {
    return { ok: false, error: 'non_digit' };
  }
  if (kind === 'ssn_last4' && digits.length !== 4) {
    return { ok: false, error: 'wrong_length' };
  }
  if (kind === 'ein' && digits.length !== 9) {
    return { ok: false, error: 'wrong_length' };
  }
  return { ok: true, digits };
}

/**
 * Hash the normalized digits with the server pepper. Throws when the
 * pepper is unset — callers must gate on isFeatureEnabled() first.
 */
export function hashTaxId(kind: TaxIdKind, digits: string): string {
  const pepper = loadPepper();
  return createHmac('sha256', pepper).update(`${kind}:${digits}`).digest('base64url');
}

/**
 * Constant-time compare an incoming raw value against a stored hash.
 * Returns false when:
 *   - the pepper isn't configured
 *   - the raw value fails normalization
 *   - the hashes don't match
 */
export function verifyTaxId(kind: TaxIdKind, raw: string, storedHash: string): boolean {
  if (!isFeatureEnabled()) return false;
  const norm = normalizeTaxId(kind, raw);
  if (!norm.ok) return false;
  const computed = hashTaxId(kind, norm.digits);
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
