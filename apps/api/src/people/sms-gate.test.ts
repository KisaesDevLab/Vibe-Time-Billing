// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { pickSmsPhone } from './sms-gate';

describe('pickSmsPhone', () => {
  it('prefers mobile, falls back to phone, treats blanks as missing', () => {
    expect(pickSmsPhone({ mobile: '+1555', phone: '+1444' })).toBe('+1555');
    expect(pickSmsPhone({ mobile: '', phone: '+1444' })).toBe('+1444');
    expect(pickSmsPhone({ mobile: '   ', phone: ' +1444 ' })).toBe('+1444');
    expect(pickSmsPhone({ mobile: null, phone: null })).toBeNull();
  });
  it('returns null for an SMS opt-out even when numbers exist', () => {
    expect(pickSmsPhone({ mobile: '+1555', phone: '+1444', smsOptOut: true })).toBeNull();
  });
});
