// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { detectPiiPatterns } from './pii';

describe('detectPiiPatterns', () => {
  it('flags SSNs with separators or an SSN keyword, not any 9 digits', () => {
    expect(detectPiiPatterns('my ssn is 123-45-6789')).toContain('ssn');
    expect(detectPiiPatterns('SSN 123456789')).toContain('ssn');
    expect(detectPiiPatterns('order 123456789 shipped')).not.toContain('ssn');
    expect(detectPiiPatterns('call 312-555-0148')).not.toContain('ssn');
  });
  it('flags EINs and Luhn-valid cards', () => {
    expect(detectPiiPatterns('EIN 12-3456789')).toContain('ein');
    expect(detectPiiPatterns('card 4111 1111 1111 1111')).toContain('card');
    expect(detectPiiPatterns('ref 4111 1111 1111 1112')).not.toContain('card');
  });
  it('flags routing numbers with a valid ABA checksum and account keywords', () => {
    expect(detectPiiPatterns('routing 021000021')).toContain('routing');
    expect(detectPiiPatterns('acct # 000123456789')).toContain('account');
    expect(detectPiiPatterns('account number: 12345678')).toContain('account');
  });
  it('flags dates of birth near a keyword only', () => {
    expect(detectPiiPatterns('DOB 04/12/1981')).toContain('dob');
    expect(detectPiiPatterns('born 1981-04-12')).toContain('dob');
    expect(detectPiiPatterns('meet on 04/12/2026')).not.toContain('dob');
  });
  it('returns nothing for plain text', () => {
    expect(detectPiiPatterns('Can we do 3pm instead?')).toEqual([]);
    expect(detectPiiPatterns('')).toEqual([]);
  });
});
