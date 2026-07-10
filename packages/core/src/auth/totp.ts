// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// TOTP enrollment + verification.
//
// Q5 locked decision: TOTP enrollment is mandatory for all staff. The
// secret is stored encrypted-at-rest on `app_user.totp_secret_encrypted`.
// Recovery codes are SHA-256 hashed at rest (single-use).

import { authenticator } from 'otplib';
import { createHash, randomBytes } from 'node:crypto';

authenticator.options = { window: 1, step: 30 };

export interface TotpEnrollment {
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
  recoveryCodeHashes: string[];
}

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function generateOtpauthUri(args: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  return authenticator.keyuri(args.accountName, args.issuer, args.secret);
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => formatRecoveryCode(randomBytes(5).toString('hex')));
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

export function verifyTotp(args: { token: string; secret: string }): boolean {
  // otplib expects the token without whitespace; users often paste it
  // with a space, so we strip them defensively.
  return authenticator.verify({ token: args.token.replace(/\s+/g, ''), secret: args.secret });
}

export function newEnrollment(args: { accountName: string; issuer: string }): TotpEnrollment {
  const secret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();
  return {
    secret,
    otpauthUri: generateOtpauthUri({ secret, accountName: args.accountName, issuer: args.issuer }),
    recoveryCodes,
    recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
  };
}

function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]+/g, '').toLowerCase();
}

function formatRecoveryCode(raw: string): string {
  // xxxxx-xxxxx style. Easier to read aloud / write down.
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
}
