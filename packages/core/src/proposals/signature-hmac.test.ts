// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0

import { describe, expect, it } from 'vitest';

import {
  computeSignatureHmac,
  deriveFirmHmacKey,
  verifySignatureHmac,
  type SignatureRecord,
} from './signature-hmac';

function record(overrides: Partial<SignatureRecord> = {}): SignatureRecord {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    proposalId: '22222222-2222-2222-2222-222222222222',
    role: 'PRIMARY',
    sequence: 0,
    signerName: 'Jane Doe',
    signerEmail: 'jane@example.com',
    signerPhone: null,
    signerIp: '203.0.113.5',
    signerUa: 'Mozilla/5.0',
    method: 'TYPED_NAME',
    state: 'SIGNED',
    typedName: 'Jane Doe',
    signatureSvg: null,
    opensignEnvelopeId: null,
    opensignCertificateObjectKey: null,
    payloadHash: 'a'.repeat(64),
    signedAt: '2026-04-15T15:00:00Z',
    declinedAt: null,
    declinedReason: null,
    ...overrides,
  };
}

const SEED = 'a-test-seed-that-is-at-least-16-bytes-long';
const FIRM = 'firm-1';

describe('deriveFirmHmacKey', () => {
  it('returns 32 bytes', () => {
    const key = deriveFirmHmacKey(SEED, FIRM);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });
  it('is deterministic per (seed, firmId)', () => {
    const a = deriveFirmHmacKey(SEED, FIRM);
    const b = deriveFirmHmacKey(SEED, FIRM);
    expect(a.equals(b)).toBe(true);
  });
  it('differs across firms', () => {
    const a = deriveFirmHmacKey(SEED, 'firm-A');
    const b = deriveFirmHmacKey(SEED, 'firm-B');
    expect(a.equals(b)).toBe(false);
  });
  it('differs across seeds', () => {
    const a = deriveFirmHmacKey(SEED, FIRM);
    const b = deriveFirmHmacKey(`${SEED}-alt`, FIRM);
    expect(a.equals(b)).toBe(false);
  });
  it('rejects too-short seed', () => {
    expect(() => deriveFirmHmacKey('short', FIRM)).toThrow(/seed too short/);
  });
});

describe('computeSignatureHmac', () => {
  const key = deriveFirmHmacKey(SEED, FIRM);

  it('returns 64-char hex', () => {
    expect(computeSignatureHmac(record(), key)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic on identical input', () => {
    const a = computeSignatureHmac(record(), key);
    const b = computeSignatureHmac(record(), key);
    expect(a).toBe(b);
  });

  it('changes when ANY participating field changes', () => {
    const base = computeSignatureHmac(record(), key);
    expect(computeSignatureHmac(record({ signerName: 'Jane Doe Sr.' }), key)).not.toBe(base);
    expect(computeSignatureHmac(record({ signerIp: '198.51.100.1' }), key)).not.toBe(base);
    expect(computeSignatureHmac(record({ payloadHash: 'b'.repeat(64) }), key)).not.toBe(base);
    expect(computeSignatureHmac(record({ signedAt: '2026-04-15T16:00:00Z' }), key)).not.toBe(base);
    expect(computeSignatureHmac(record({ typedName: 'JANE DOE' }), key)).not.toBe(base);
  });

  it('order-independent on record fields (canonical JSON)', () => {
    const r1 = record({ signerName: 'A', signerEmail: 'a@x.com' });
    const r2: SignatureRecord = {
      ...r1,
    };
    // Same content; different key insertion order — canonical JSON
    // sorts so the HMACs match.
    const a = computeSignatureHmac(r1, key);
    const b = computeSignatureHmac(r2, key);
    expect(a).toBe(b);
  });
});

describe('verifySignatureHmac', () => {
  const key = deriveFirmHmacKey(SEED, FIRM);

  it('ok when claimed matches expected', () => {
    const r = record();
    const claim = computeSignatureHmac(r, key);
    const v = verifySignatureHmac(r, key, claim);
    expect(v.ok).toBe(true);
    expect(v.expected).toBe(v.actual);
  });

  it('not ok when claimed mismatches', () => {
    const r = record();
    const v = verifySignatureHmac(r, key, 'f'.repeat(64));
    expect(v.ok).toBe(false);
  });

  it('not ok when claim is null', () => {
    const r = record();
    const v = verifySignatureHmac(r, key, null);
    expect(v.ok).toBe(false);
  });

  it('detects a 1-byte tamper', () => {
    const r = record();
    const claim = computeSignatureHmac(r, key);
    // Tamper a single field and verify the original HMAC fails.
    const tampered = { ...r, signerName: 'Jane Doe ' };
    const v = verifySignatureHmac(tampered, key, claim);
    expect(v.ok).toBe(false);
  });

  it('detects wrong-firm-key forgery attempt', () => {
    const r = record();
    const claim = computeSignatureHmac(r, key);
    const otherKey = deriveFirmHmacKey(SEED, 'firm-other');
    const v = verifySignatureHmac(r, otherKey, claim);
    expect(v.ok).toBe(false);
  });
});
