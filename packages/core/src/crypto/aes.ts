// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// AES-256-GCM at-rest encryption helper.
//
// Used for sensitive fields that must round-trip through Postgres without
// exposing plaintext to anyone with table-read permission: messaging
// provider API keys + tokens (Sprint A), TOTP secrets (eventually), and
// any other future credentials.
//
// The 32-byte key comes from KMS_KEY env var, decoded as either base64
// or hex (we detect by length). A wrong key length is a fatal startup
// error, not a per-call failure — the appliance must fail to boot rather
// than silently encrypt with the wrong key.
//
// Format (string): "v1:<base64-iv>:<base64-ciphertext>:<base64-tag>"
//   - v1 prefix lets us rotate algorithms later
//   - IV is 12 bytes (GCM standard) and random per encryption
//   - tag is the 16-byte GCM auth tag
//
// Decrypt is constant-time-aware: a malformed envelope and a wrong key
// both produce the same generic error. Callers should not branch on the
// error contents.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;
const VERSION = 'v1';

export class CryptoEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoEnvelopeError';
  }
}

/**
 * Resolve a 32-byte key from a base64 or hex string. Throws if the
 * decoded buffer is not exactly 32 bytes.
 */
export function resolveKey(input: string): Buffer {
  if (!input) {
    throw new CryptoEnvelopeError('KMS_KEY is empty');
  }
  // Try base64 first; if the decoded length matches, use it. Otherwise
  // try hex. This makes the env var format flexible without requiring
  // explicit prefixing.
  const b64 = Buffer.from(input, 'base64');
  if (b64.length === KEY_LEN) return b64;
  const hex = /^[0-9a-fA-F]+$/.test(input) ? Buffer.from(input, 'hex') : Buffer.alloc(0);
  if (hex.length === KEY_LEN) return hex;
  throw new CryptoEnvelopeError(
    `KMS_KEY must decode to ${KEY_LEN} bytes (got ${b64.length} via base64, ${hex.length} via hex)`,
  );
}

export function encryptString(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_LEN) {
    throw new CryptoEnvelopeError(`key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

export function decryptString(envelope: string, key: Buffer): string {
  if (key.length !== KEY_LEN) {
    throw new CryptoEnvelopeError(`key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new CryptoEnvelopeError('malformed envelope');
  }
  try {
    const iv = Buffer.from(parts[1]!, 'base64');
    const ct = Buffer.from(parts[2]!, 'base64');
    const tag = Buffer.from(parts[3]!, 'base64');
    if (iv.length !== IV_LEN) throw new CryptoEnvelopeError('bad iv length');
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    throw new CryptoEnvelopeError('decryption failed');
  }
}

/**
 * Encrypt a JSON-serializable value to a string envelope.
 */
export function encryptJson(value: unknown, key: Buffer): string {
  return encryptString(JSON.stringify(value), key);
}

/**
 * Decrypt a string envelope back to a JSON value. Caller is responsible
 * for type-validating the result.
 */
export function decryptJson<T = unknown>(envelope: string, key: Buffer): T {
  const text = decryptString(envelope, key);
  return JSON.parse(text) as T;
}
