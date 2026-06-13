// SPDX-License-Identifier: Elastic-2.0
//
// Per-signer in-office QR token: round-trips, rejects tampering, honors expiry.

import { describe, expect, it, beforeAll } from 'vitest';

import { mintInOfficeToken, verifyInOfficeToken } from '../signatures/in-office-token';

beforeAll(() => {
  process.env['STAFF_JWT_SECRET'] = 'test-in-office-secret';
});

describe('in-office token', () => {
  it('round-trips requestId + signerId', () => {
    const t = mintInOfficeToken('req-1', 'sig-1');
    expect(verifyInOfficeToken(t)).toEqual({ requestId: 'req-1', signerId: 'sig-1' });
  });

  it('rejects a tampered payload', () => {
    const t = mintInOfficeToken('req-1', 'sig-1');
    const [, mac] = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ r: 'req-1', s: 'evil', e: 9999999999 })).toString('base64url')}.${mac}`;
    expect(verifyInOfficeToken(forged)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyInOfficeToken('nope')).toBeNull();
    expect(verifyInOfficeToken('')).toBeNull();
    expect(verifyInOfficeToken('a.b.c')).toBeNull();
  });

  it('rejects an expired token', () => {
    const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    const t = mintInOfficeToken('req-1', 'sig-1', past, 30); // expired 30 days ago
    expect(verifyInOfficeToken(t)).toBeNull();
  });

  it('does not verify under a different secret', () => {
    const t = mintInOfficeToken('req-1', 'sig-1');
    process.env['STAFF_JWT_SECRET'] = 'a-different-secret';
    expect(verifyInOfficeToken(t)).toBeNull();
    process.env['STAFF_JWT_SECRET'] = 'test-in-office-secret';
  });
});
