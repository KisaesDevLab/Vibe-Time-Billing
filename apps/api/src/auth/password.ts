// SPDX-License-Identifier: Elastic-2.0
//
// 0087 — password hashing helpers for staff sign-in.
//
// argon2id via @node-rs/argon2 (OWASP-recommended). The parameters
// below are the defaults (m=19 MiB, t=2, p=1) which match the OWASP
// 2023 minimum and complete in ~30ms on a modern x86 core. Native
// Rust binding ships pre-built binaries for linux-amd64, linux-arm64,
// macOS, and Windows — no compile step on the appliance.

import { hash, verify } from '@node-rs/argon2';

/** OWASP-recommended minimum. Higher is fine; no upper bound. */
export const MIN_PASSWORD_LENGTH = 12;

/** Hard upper bound so a giant payload can't DoS the hasher. */
export const MAX_PASSWORD_LENGTH = 256;

export interface PasswordPolicyResult {
  ok: boolean;
  reason?: 'too_short' | 'too_long' | 'whitespace_only';
}

export function checkPasswordPolicy(pw: string): PasswordPolicyResult {
  if (pw.trim().length === 0) return { ok: false, reason: 'whitespace_only' };
  if (pw.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'too_short' };
  if (pw.length > MAX_PASSWORD_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true };
}

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext);
}

/**
 * Verify a plaintext password against an argon2id digest. Returns false
 * on any failure (bad digest, wrong password, etc.) — never throws on
 * a verification miss so callers can branch cleanly. Throws only on
 * genuinely broken input.
 */
export async function verifyPassword(plaintext: string, digest: string): Promise<boolean> {
  try {
    return await verify(digest, plaintext);
  } catch {
    return false;
  }
}
