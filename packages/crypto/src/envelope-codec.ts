// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// EnvelopeCodec — XChaCha20-Poly1305 authenticated encryption used at
// every encryption point in TB (MFK ↔ KEK, T-DEK ↔ MFK, content ↔
// T-DEK).
//
// Stack:
//   @noble/ciphers — pure-JS XChaCha20-Poly1305 (24-byte nonce; large
//                    enough that random-nonce collisions are
//                    negligible across the appliance's lifetime).
//   @noble/hashes  — randomBytes for nonce + key + salt generation.
//   argon2         — Argon2id KDF for the admin-passphrase mode KEK.
//
// Output format for every encrypted blob:
//   [nonce 24 bytes] [ciphertext + tag (16 bytes)]
//
// The codec hides the nonce/ciphertext split from callers.

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/hashes/utils';
import argon2 from 'argon2';

const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const SALT_BYTES = 16;

export interface EncryptedBlob {
  /** [nonce | ciphertext+tag] — store this as-is. */
  bytes: Uint8Array;
}

/**
 * Encrypt plaintext with the given 32-byte key. Returns nonce-prefixed
 * ciphertext. Caller stores the returned bytes opaquely.
 */
export function encrypt(plaintext: Uint8Array, key: Uint8Array): EncryptedBlob {
  if (key.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = xchacha20poly1305(key, nonce);
  const ct = cipher.encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return { bytes: out };
}

/**
 * Decrypt nonce-prefixed ciphertext with the given 32-byte key. Throws
 * if the tag fails verification (tampered data, wrong key, etc.).
 */
export function decrypt(blob: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`);
  if (blob.length < NONCE_BYTES + 16) throw new Error('ciphertext too short');
  const nonce = blob.subarray(0, NONCE_BYTES);
  const ct = blob.subarray(NONCE_BYTES);
  const cipher = xchacha20poly1305(key, nonce);
  return cipher.decrypt(ct);
}

/**
 * Generate a fresh random 32-byte key. Used for MFK + T-DEK generation.
 */
export function generateKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

/**
 * Generate a random 16-byte salt for Argon2id derivation.
 */
export function generateSalt(): Uint8Array {
  return randomBytes(SALT_BYTES);
}

export interface Argon2Params {
  /** Iteration count. argon2 lib default is 3; we use 4 for stronger key. */
  timeCost: number;
  /** Memory in KiB. Default 64 MiB = 65536. */
  memoryCost: number;
  /** Threads. Default 1. */
  parallelism: number;
}

export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  timeCost: 4,
  memoryCost: 65536, // 64 MiB
  parallelism: 1,
};

/**
 * Derive a 32-byte KEK from a passphrase via Argon2id. Used in
 * admin-passphrase unlock mode.
 */
export async function deriveKekFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<Uint8Array> {
  if (salt.length !== SALT_BYTES) {
    throw new Error(`salt must be ${SALT_BYTES} bytes`);
  }
  // The argon2 lib returns a Buffer when raw=true. We then slice to a
  // Uint8Array view to keep the type contract crypto-friendly.
  const buf = await argon2.hash(passphrase, {
    type: argon2.argon2id,
    salt: Buffer.from(salt),
    timeCost: params.timeCost,
    memoryCost: params.memoryCost,
    parallelism: params.parallelism,
    hashLength: KEY_BYTES,
    raw: true,
  });
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// =====================================================================
// Password hashing — Argon2id with embedded salt/params. Returns
// the standard $argon2id$v=19$m=…,t=…,p=…$<salt>$<hash> string so a
// stored hash is self-describing and verifiable without storing
// params separately.
// =====================================================================

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    timeCost: 3,
    memoryCost: 64 * 1024,
    parallelism: 1,
  });
}

export async function verifyPassword(stored: string, supplied: string): Promise<boolean> {
  try {
    return await argon2.verify(stored, supplied);
  } catch {
    return false;
  }
}
