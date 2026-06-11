// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect } from 'vitest';

import { detectLoginKind, generateSmsOtp, hashSmsOtp, normalizePhone } from './sms-otp';

describe('sms otp', () => {
  it('generates 6-digit codes', () => {
    for (let i = 0; i < 50; i++) expect(generateSmsOtp()).toMatch(/^\d{6}$/);
  });
  it('hashes deterministically', () => {
    expect(hashSmsOtp('123456')).toBe(hashSmsOtp('123456'));
    expect(hashSmsOtp('123456')).not.toBe(hashSmsOtp('123457'));
  });
});

describe('normalizePhone', () => {
  it('formats 10-digit US numbers to E.164', () => {
    expect(normalizePhone('3125550148')).toBe('+13125550148');
    expect(normalizePhone('(312) 555-0148')).toBe('+13125550148');
  });
  it('accepts already-prefixed', () => {
    expect(normalizePhone('+13125550148')).toBe('+13125550148');
  });
  it('rejects garbage', () => {
    expect(normalizePhone('abc')).toBeNull();
  });
});

describe('detectLoginKind', () => {
  it('detects email and phone', () => {
    const ATSIGN = '@';
    expect(detectLoginKind(`user${ATSIGN}example.com`)).toBe('email');
    expect(detectLoginKind('3125550148')).toBe('phone');
    expect(detectLoginKind('garbage')).toBe('unknown');
  });
});
