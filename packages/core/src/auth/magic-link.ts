// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Magic-link issuance and verification using signed JWTs.
//
// Realm separation (CLAUDE.md non-negotiable #2): every caller passes the
// realm-specific signing key. There is no shared key. Tokens minted for
// staff cannot validate against the portal key and vice versa.

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export type AuthRealm = 'staff' | 'portal';

export interface MagicLinkPayload extends JWTPayload {
  sub: string; // app_user_id or portal_identity_id
  fid: string; // firm_id
  rlm: AuthRealm;
  pur: 'magic_link';
  nce: string; // nonce — guards against replay (paired with a Redis used-set)
}

export interface IssueMagicLinkArgs {
  subjectId: string;
  firmId: string;
  realm: AuthRealm;
  signingKey: Uint8Array;
  ttlSeconds: number;
  nonce: string;
}

export async function issueMagicLink(args: IssueMagicLinkArgs): Promise<string> {
  return new SignJWT({
    fid: args.firmId,
    rlm: args.realm,
    pur: 'magic_link',
    nce: args.nonce,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(args.subjectId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + args.ttlSeconds)
    .setIssuer(`vibe-tb:${args.realm}`)
    .setAudience(`vibe-tb:${args.realm}:magic-link`)
    .sign(args.signingKey);
}

export interface VerifyMagicLinkArgs {
  token: string;
  realm: AuthRealm;
  signingKey: Uint8Array;
}

export async function verifyMagicLink(args: VerifyMagicLinkArgs): Promise<MagicLinkPayload> {
  const { payload } = await jwtVerify(args.token, args.signingKey, {
    issuer: `vibe-tb:${args.realm}`,
    audience: `vibe-tb:${args.realm}:magic-link`,
  });
  if (payload['pur'] !== 'magic_link') throw new Error('not a magic_link token');
  if (payload['rlm'] !== args.realm) throw new Error('realm mismatch');
  if (typeof payload['sub'] !== 'string') throw new Error('missing subject');
  if (typeof payload['fid'] !== 'string') throw new Error('missing firm');
  if (typeof payload['nce'] !== 'string') throw new Error('missing nonce');
  return payload as MagicLinkPayload;
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------
// Password-reset tokens. Same signed-JWT shape as a magic link but with a
// distinct purpose AND audience, so a reset token can never be presented
// to /verify-magic-link (and vice versa) — possession of a reset email
// must only ever let the holder set a new password, never sign in.
// ---------------------------------------------------------------------

export interface PasswordResetPayload extends JWTPayload {
  sub: string; // app_user_id
  fid: string; // firm_id
  rlm: 'staff';
  pur: 'password_reset';
  nce: string; // nonce — single-use, paired with a Redis key
}

export async function issuePasswordResetToken(args: IssueMagicLinkArgs): Promise<string> {
  return new SignJWT({
    fid: args.firmId,
    rlm: args.realm,
    pur: 'password_reset',
    nce: args.nonce,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(args.subjectId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + args.ttlSeconds)
    .setIssuer(`vibe-tb:${args.realm}`)
    .setAudience(`vibe-tb:${args.realm}:password-reset`)
    .sign(args.signingKey);
}

export async function verifyPasswordResetToken(
  args: VerifyMagicLinkArgs,
): Promise<PasswordResetPayload> {
  const { payload } = await jwtVerify(args.token, args.signingKey, {
    issuer: `vibe-tb:${args.realm}`,
    audience: `vibe-tb:${args.realm}:password-reset`,
  });
  if (payload['pur'] !== 'password_reset') throw new Error('not a password_reset token');
  if (payload['rlm'] !== args.realm) throw new Error('realm mismatch');
  if (typeof payload['sub'] !== 'string') throw new Error('missing subject');
  if (typeof payload['fid'] !== 'string') throw new Error('missing firm');
  if (typeof payload['nce'] !== 'string') throw new Error('missing nonce');
  return payload as PasswordResetPayload;
}
