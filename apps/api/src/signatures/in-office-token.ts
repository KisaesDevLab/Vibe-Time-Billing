// SPDX-License-Identifier: Elastic-2.0
//
// Per-signer in-office token. A printed QR encodes a link to the public
// in-office page carrying one of these tokens; scanning it opens the
// verify→sign flow for exactly that signer of that request. The token is a
// stateless HMAC (no DB row): payload {r:requestId, s:signerId, e:exp} signed
// with a server secret, so a public endpoint can verify it without a session.

import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_DAYS = 30;

interface TokenPayload {
  r: string; // requestId
  s: string; // signerId
  e: number; // expiry, epoch seconds
}

function secret(): string {
  // Reuse the staff JWT signing secret — same trust boundary (the API mints
  // and verifies). Never sent to the client beyond the opaque token.
  const s = process.env['STAFF_JWT_SECRET'];
  if (!s) throw new Error('STAFF_JWT_SECRET not set');
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

/** Mint a token for a signer of a request. */
export function mintInOfficeToken(
  requestId: string,
  signerId: string,
  now: Date = new Date(),
  ttlDays = DEFAULT_TTL_DAYS,
): string {
  const payload: TokenPayload = {
    r: requestId,
    s: signerId,
    e: Math.floor(now.getTime() / 1000) + ttlDays * 24 * 60 * 60,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body)}`;
}

/** Verify a token; returns {requestId, signerId} or null if invalid/expired. */
export function verifyInOfficeToken(
  token: string,
  now: Date = new Date(),
): { requestId: string; signerId: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let expected: Buffer;
  let got: Buffer;
  try {
    expected = Buffer.from(sign(body), 'utf8');
    got = Buffer.from(mac, 'utf8');
  } catch {
    return null;
  }
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return null;
  }
  if (!payload.r || !payload.s || typeof payload.e !== 'number') return null;
  if (payload.e * 1000 < now.getTime()) return null;
  return { requestId: payload.r, signerId: payload.s };
}
