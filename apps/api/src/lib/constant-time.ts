// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Single home for the string constant-time comparison used across auth,
// OTP, and webhook code — one place to fix, not N copies. Length mismatch
// returns false without a timing-safe pass; that leaks only the length,
// which for our fixed-length digests/tokens is already public.

import { timingSafeEqual } from 'node:crypto';

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
