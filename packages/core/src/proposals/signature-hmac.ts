// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P16 — Signature HMAC tamper-evidence.
//
// Each signature row stores an `hmac_signature` computed as
// HMAC-SHA256(per-firm-key, canonical(record)). On verification we
// recompute and compare; any modification to a stored field invalidates
// the HMAC.
//
// Per-firm key derivation:
//   Each firm gets a deterministic 32-byte key derived from a
//   per-appliance seed and the firm_id. The seed lives in
//   PROPOSAL_SIGNATURE_HMAC_SEED env var; if unset we fall back to the
//   existing PORTAL_JWT_SECRET so a fresh appliance still gets
//   coverage. The first principle: the same firm always derives the
//   same key, so a recomputed HMAC has the same value as the stored
//   one if and only if nothing was tampered.
//
// The schema reserves `firm_settings_proposals.hmac_secret_encrypted`
// (bytea) for the eventual encrypted-at-rest variant where each firm's
// key is wrapped by the appliance MFK. v1 derives deterministically
// so we don't have to entangle with the MFK lifecycle yet; the column
// stays NULL until that upgrade lands.

import { createHmac } from 'node:crypto';

import { canonicalize } from './canonical-json';

/**
 * Fields that participate in the signature record HMAC. The shape is
 * stable across versions — adding a new field would change every
 * existing signature's HMAC, so additions require a versioning bump.
 *
 * Empty / null fields are still included so an attacker can't change
 * an unset value to a set one without invalidating the HMAC.
 */
export interface SignatureRecord {
  id: string;
  proposalId: string;
  role: string;
  sequence: number;
  signerName: string;
  signerEmail: string;
  signerPhone: string | null;
  signerIp: string | null;
  signerUa: string | null;
  method: string;
  state: string;
  typedName: string | null;
  signatureSvg: string | null;
  opensignEnvelopeId: string | null;
  opensignCertificateObjectKey: string | null;
  payloadHash: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  declinedReason: string | null;
}

export function deriveFirmHmacKey(seed: string, firmId: string): Buffer {
  if (!seed || seed.length < 16) {
    throw new Error('signature hmac seed too short — set PROPOSAL_SIGNATURE_HMAC_SEED');
  }
  return createHmac('sha256', seed).update(firmId).digest();
}

export function computeSignatureHmac(record: SignatureRecord, key: Buffer | string): string {
  const canonical = canonicalize(record);
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  return createHmac('sha256', keyBuf).update(canonical, 'utf8').digest('hex');
}

export interface VerifyResult {
  ok: boolean;
  expected: string;
  actual: string;
}

export function verifySignatureHmac(
  record: SignatureRecord,
  key: Buffer | string,
  claimed: string | null,
): VerifyResult {
  const expected = computeSignatureHmac(record, key);
  return {
    ok: claimed != null && timingSafeStringEqual(expected, claimed),
    expected,
    actual: claimed ?? '',
  };
}

// Constant-time string compare — guards against timing attacks on the
// hmac field, even though the cost is negligible for 64-char hex.
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
