// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0233 — Twilio SMS config extensions for the two-way inbox: Messaging
// Service SID + optional API key pair, From optional once a Messaging
// Service exists, masking never leaks secrets, and the SID formats are
// validated up front (a typo'd MG sid would otherwise fail silently at
// send time).

import { describe, expect, it } from 'vitest';

import { SmsConfig, maskSmsConfig } from '../messaging/config';

const AC = 'AC' + 'a'.repeat(32);
const MG = 'MG' + 'b'.repeat(32);
const SK = 'SK' + 'c'.repeat(32);

describe('TwilioConfig (0233)', () => {
  it('accepts a Messaging Service SID without a From number', () => {
    const r = SmsConfig.safeParse({
      provider: 'twilio',
      accountSid: AC,
      authToken: 'token-12345',
      messagingServiceSid: MG,
    });
    expect(r.success).toBe(true);
  });

  it('still accepts the legacy From-only shape', () => {
    const r = SmsConfig.safeParse({
      provider: 'twilio',
      accountSid: AC,
      authToken: 'token-12345',
      from: '+12025550100',
    });
    expect(r.success).toBe(true);
  });

  it('rejects twilio with neither From nor Messaging Service', () => {
    const r = SmsConfig.safeParse({ provider: 'twilio', accountSid: AC, authToken: 'token-12345' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === 'from')).toBe(true);
  });

  it('rejects a half API key pair', () => {
    const r = SmsConfig.safeParse({
      provider: 'twilio',
      accountSid: AC,
      authToken: 'token-12345',
      messagingServiceSid: MG,
      apiKeySid: SK,
    });
    expect(r.success).toBe(false);
  });

  it('validates SID prefixes', () => {
    expect(
      SmsConfig.safeParse({
        provider: 'twilio',
        accountSid: 'notasid',
        authToken: 'token-12345',
        messagingServiceSid: MG,
      }).success,
    ).toBe(false);
    expect(
      SmsConfig.safeParse({
        provider: 'twilio',
        accountSid: AC,
        authToken: 'token-12345',
        messagingServiceSid: 'MG-short',
      }).success,
    ).toBe(false);
  });

  it('textlink is unaffected', () => {
    expect(SmsConfig.safeParse({ provider: 'textlink', apiKey: 'k'.repeat(12) }).success).toBe(
      true,
    );
  });

  it('masks secrets and reports inboxReady', () => {
    const m = maskSmsConfig({
      provider: 'twilio',
      accountSid: AC,
      authToken: 'token-12345',
      messagingServiceSid: MG,
      apiKeySid: SK,
      apiKeySecret: 'supersecret',
    });
    expect(m.provider).toBe('twilio');
    expect(m.messagingServiceSid).toBe(MG);
    expect(m.inboxReady).toBe(true);
    expect(m.apiKeySecretMasked).not.toContain('supersecret');
    expect(m.authTokenMasked).not.toContain('token-12345');
    expect(JSON.stringify(m)).not.toContain('supersecret');
    const legacy = maskSmsConfig({
      provider: 'twilio',
      accountSid: AC,
      authToken: 'token-12345',
      from: '+12025550100',
    });
    expect(legacy.inboxReady).toBe(false);
  });
});
