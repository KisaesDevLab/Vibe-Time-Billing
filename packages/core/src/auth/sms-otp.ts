// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// SMS OTP for portal login. 6-digit codes, 5-minute expiry, single-use,
// rate-limited by phone number (Q29).

import { createHash, randomInt } from 'node:crypto';

export function generateSmsOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashSmsOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Normalize a US phone to E.164 (best-effort). */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D+/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (input.startsWith('+') && digits.length >= 10) return `+${digits}`;
  return null;
}

/** Cheap-but-reliable detection: phone-like vs email-like. */
export function detectLoginKind(raw: string): 'email' | 'phone' | 'unknown' {
  const trimmed = raw.trim();
  if (trimmed.includes('@') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'email';
  if (normalizePhone(trimmed)) return 'phone';
  return 'unknown';
}
