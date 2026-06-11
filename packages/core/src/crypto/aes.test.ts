// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptString,
  decryptString,
  encryptJson,
  decryptJson,
  resolveKey,
  CryptoEnvelopeError,
} from './aes';

describe('aes envelope', () => {
  const key = randomBytes(32);

  it('round-trips a string', () => {
    const env = encryptString('hello, world', key);
    expect(env.startsWith('v1:')).toBe(true);
    expect(decryptString(env, key)).toBe('hello, world');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptString('same plaintext', key);
    const b = encryptString('same plaintext', key);
    expect(a).not.toBe(b);
  });

  it('round-trips JSON', () => {
    const env = encryptJson({ api_key: 'sk_test_abc', from: '[email protected]' }, key);
    const out = decryptJson<{ api_key: string; from: string }>(env, key);
    expect(out).toEqual({ api_key: 'sk_test_abc', from: '[email protected]' });
  });

  it('rejects a wrong key', () => {
    const env = encryptString('secret', key);
    const wrong = randomBytes(32);
    expect(() => decryptString(env, wrong)).toThrow(CryptoEnvelopeError);
  });

  it('rejects a tampered ciphertext', () => {
    const env = encryptString('secret', key);
    const tampered = env.slice(0, -2) + 'aa';
    expect(() => decryptString(tampered, key)).toThrow(CryptoEnvelopeError);
  });

  it('rejects malformed envelope', () => {
    expect(() => decryptString('not-an-envelope', key)).toThrow(CryptoEnvelopeError);
    expect(() => decryptString('v0:a:b:c', key)).toThrow(CryptoEnvelopeError);
  });

  it('rejects wrong key length', () => {
    expect(() => encryptString('x', Buffer.alloc(16))).toThrow(CryptoEnvelopeError);
    expect(() => decryptString('v1:a:b:c', Buffer.alloc(16))).toThrow(CryptoEnvelopeError);
  });

  describe('resolveKey', () => {
    it('accepts a base64 32-byte key', () => {
      const raw = randomBytes(32);
      const b64 = raw.toString('base64');
      expect(resolveKey(b64).equals(raw)).toBe(true);
    });

    it('accepts a hex 32-byte key', () => {
      const raw = randomBytes(32);
      const hex = raw.toString('hex');
      expect(resolveKey(hex).equals(raw)).toBe(true);
    });

    it('rejects wrong-length keys', () => {
      expect(() => resolveKey('')).toThrow(CryptoEnvelopeError);
      expect(() => resolveKey('short')).toThrow(CryptoEnvelopeError);
    });
  });
});
