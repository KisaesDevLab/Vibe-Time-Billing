// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// TR-5 — Staff "view-as-client" impersonation tokens.
//
// Issues short-lived (5 min) JWTs claim-bound to a specific
// (client_id, access_id, staff_user_id). The portal recognizes the
// token, sets `req.portalSession.isImpersonation = true`, and a
// read-only middleware rejects every non-GET request during the
// session.
//
// The JWT signing key is intentionally distinct from
// PORTAL_JWT_SECRET — an impersonation token must NOT be usable as a
// normal portal session. We derive a key by HKDF from
// STAFF_JWT_SECRET: same root of trust as the staff session, but
// scoped to the 'tax-impersonation/v1' label so a leaked staff
// session cookie can't be replayed as an impersonation token.

import { createHash } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';
import type { NextFunction, Request, Response } from 'express';

export const IMPERSONATION_TTL_SECONDS = 5 * 60;
const ISSUER = 'vibetb';
const AUDIENCE = 'portal-impersonation';

export interface ImpersonationClaims {
  kind: 'staff_impersonation';
  clientId: string;
  accessId: string;
  staffUserId: string;
  staffEmail: string;
  exp: number;
  iat: number;
}

function deriveKey(staffSecret: string): Uint8Array {
  // Match the proposal-module pattern: SHA-256 over (secret || label).
  // Not full HKDF but the input range is fixed so this is sufficient
  // and avoids a webcrypto-vs-node-crypto import branch.
  const buf = createHash('sha256')
    .update(staffSecret, 'utf8')
    .update('tax-impersonation/v1', 'utf8')
    .digest();
  return new Uint8Array(buf);
}

export interface IssueImpersonationInput {
  staffSecret: string;
  clientId: string;
  accessId: string;
  staffUserId: string;
  staffEmail: string;
  // Test seam — defaults to Date.now() / 1000.
  nowSeconds?: number;
}

export async function issueImpersonationToken(
  input: IssueImpersonationInput,
): Promise<{ token: string; expiresAt: Date }> {
  const key = deriveKey(input.staffSecret);
  const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + IMPERSONATION_TTL_SECONDS;
  const token = await new SignJWT({
    kind: 'staff_impersonation',
    clientId: input.clientId,
    accessId: input.accessId,
    staffUserId: input.staffUserId,
    staffEmail: input.staffEmail,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);
  return { token, expiresAt: new Date(exp * 1000) };
}

export class ImpersonationTokenError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'ImpersonationTokenError';
  }
}

export async function verifyImpersonationToken(
  staffSecret: string,
  token: string,
): Promise<ImpersonationClaims> {
  const key = deriveKey(staffSecret);
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const claims = payload as unknown as ImpersonationClaims;
    if (claims.kind !== 'staff_impersonation') {
      throw new ImpersonationTokenError('wrong_kind');
    }
    if (
      typeof claims.clientId !== 'string' ||
      typeof claims.accessId !== 'string' ||
      typeof claims.staffUserId !== 'string'
    ) {
      throw new ImpersonationTokenError('malformed');
    }
    return claims;
  } catch (err) {
    if (err instanceof ImpersonationTokenError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'ERR_JWT_EXPIRED') throw new ImpersonationTokenError('expired');
    throw new ImpersonationTokenError('invalid');
  }
}

// =====================================================================
// Read-only middleware
//
// During an impersonation session, any non-GET request returns 403.
// The portal flag is on `req.portalSession.isImpersonation` (set by
// the auth layer when it recognizes the impersonation token).
// =====================================================================

export function requireReadOnlyDuringImpersonation(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const session = req.portalSession;
  if (session && (session as unknown as { isImpersonation?: boolean }).isImpersonation) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      res.status(403).json({ error: 'impersonation_is_read_only' });
      return;
    }
  }
  next();
}
