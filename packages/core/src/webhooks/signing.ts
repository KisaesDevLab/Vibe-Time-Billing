// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Outbound webhook signing + verification. HMAC-SHA256 over the raw
// payload, with a unix-second timestamp to defeat replay.

import { createHmac, timingSafeEqual } from 'node:crypto';

const REPLAY_WINDOW_SECONDS = 5 * 60;

export function signPayload(args: { secret: string; payload: string; timestamp?: number }): string {
  const ts = args.timestamp ?? Math.floor(Date.now() / 1000);
  const signed = `${ts}.${args.payload}`;
  const sig = createHmac('sha256', args.secret).update(signed).digest('hex');
  return `t=${ts},v1=${sig}`;
}

export function verifySignature(args: {
  secret: string;
  payload: string;
  header: string;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(args.header);
  if (!match) return { ok: false, reason: 'malformed_header' };
  const ts = Number(match[1]);
  const sig = match[2]!;
  const now = args.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }
  const expected = createHmac('sha256', args.secret).update(`${ts}.${args.payload}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}
