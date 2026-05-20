// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { describe, it, expect } from 'vitest';
import { authenticator } from 'otplib';

import {
  generateTotpSecret,
  generateOtpauthUri,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyTotp,
  newEnrollment,
} from './totp';

describe('totp', () => {
  it('generates base32 secrets long enough for HMAC-SHA1', () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBeGreaterThanOrEqual(16);
  });

  it('verifies a freshly-generated token', () => {
    const secret = generateTotpSecret();
    const token = authenticator.generate(secret);
    expect(verifyTotp({ token, secret })).toBe(true);
  });

  it('rejects a token from a different secret', () => {
    const secret1 = generateTotpSecret();
    const secret2 = generateTotpSecret();
    const token = authenticator.generate(secret2);
    expect(verifyTotp({ token, secret: secret1 })).toBe(false);
  });

  it('tolerates whitespace in user-pasted tokens', () => {
    const secret = generateTotpSecret();
    const token = authenticator.generate(secret);
    const spaced = `${token.slice(0, 3)} ${token.slice(3)}`;
    expect(verifyTotp({ token: spaced, secret })).toBe(true);
  });

  it('produces an otpauth URI with the expected shape', () => {
    const uri = generateOtpauthUri({
      secret: 'JBSWY3DPEHPK3PXP',
      accountName: '[email protected]',
      issuer: 'Granite Peak CPAs',
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Granite');
  });
});

describe('recovery codes', () => {
  it('generates 10 unique codes by default', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
  });

  it('hashes codes deterministically and ignores formatting whitespace', () => {
    const code = 'abcde-12345';
    const h1 = hashRecoveryCode(code);
    const h2 = hashRecoveryCode('ABCDE-12345');
    const h3 = hashRecoveryCode('abcde12345');
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
  });

  it('produces different hashes for different codes', () => {
    expect(hashRecoveryCode('aaaaa-bbbbb')).not.toBe(hashRecoveryCode('aaaaa-bbbbc'));
  });
});

describe('newEnrollment', () => {
  it('produces secret, otpauth URI, raw and hashed codes', () => {
    const enrollment = newEnrollment({
      accountName: '[email protected]',
      issuer: 'Vibe Time & Billing',
    });
    expect(enrollment.secret.length).toBeGreaterThan(0);
    expect(enrollment.otpauthUri).toContain('otpauth://totp/');
    expect(enrollment.recoveryCodes).toHaveLength(10);
    expect(enrollment.recoveryCodeHashes).toHaveLength(10);
    expect(enrollment.recoveryCodeHashes[0]).toBe(hashRecoveryCode(enrollment.recoveryCodes[0]!));
  });
});
