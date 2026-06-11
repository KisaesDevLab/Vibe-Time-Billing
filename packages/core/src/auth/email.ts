// SPDX-License-Identifier: Elastic-2.0
//
// Email normalization for firm-global person dedup. Pairs with
// normalizePhone (sms-otp.ts). Trim + lowercase + light validation; the
// result is the canonical dedup key (person email is stored normalized).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Return a trimmed, lowercased email, or null if it isn't a valid address. */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const e = input.trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}
