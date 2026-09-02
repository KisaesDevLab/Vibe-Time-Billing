// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0233 — Twilio signature helpers shared by the appointment and inbox
// webhooks. The proxy case matters most: Twilio signs the PUBLIC URL the
// firm pasted into the console, so verification must try every configured
// base (firm override → PUBLIC_BASE_URL → APP_BASE_URL) rather than the
// internal request host.

import { describe, expect, it } from 'vitest';

import {
  findValidTwilioUrl,
  signTwilioRequest,
  twilioSignatureValid,
  twilioUrlCandidates,
} from '../sms/twilio-signature';

describe('twilio signature helpers', () => {
  const params = { From: '+12025550100', Body: 'hi', MessageSid: 'SM1' };

  it('round-trips sign → verify and rejects a wrong token', () => {
    const url = 'https://practice.example/api/sms/twilio/inbound';
    const sig = signTwilioRequest('tok', url, params);
    expect(twilioSignatureValid(['tok'], url, params, sig)).toBe(true);
    expect(twilioSignatureValid(['other'], url, params, sig)).toBe(false);
    expect(twilioSignatureValid(['tok'], url, { ...params, Body: 'tampered' }, sig)).toBe(false);
    expect(twilioSignatureValid(['tok'], url, params, undefined)).toBe(false);
  });

  it('builds candidates from every base, deduped, with port variants', () => {
    const c = twilioUrlCandidates(
      ['https://practice.example/', 'https://practice.example', 'http://localhost:3001', null],
      '/api/sms/twilio/inbound',
    );
    expect(c).toContain('https://practice.example/api/sms/twilio/inbound');
    expect(c).toContain('https://practice.example:443/api/sms/twilio/inbound');
    expect(c).toContain('http://localhost:3001/api/sms/twilio/inbound');
    expect(new Set(c).size).toBe(c.length);
  });

  it('verifies against the public URL when the request arrived on the internal host', () => {
    const publicUrl = 'https://practice.example/api/sms/twilio/inbound';
    const sig = signTwilioRequest('tok', publicUrl, params);
    const candidates = twilioUrlCandidates(
      ['https://practice.example', 'http://localhost:3001'],
      '/api/sms/twilio/inbound',
    );
    expect(findValidTwilioUrl(['tok'], candidates, params, sig)).toBe(publicUrl);
    expect(
      findValidTwilioUrl(
        ['tok'],
        twilioUrlCandidates(['http://localhost:3001'], '/api/sms/twilio/inbound'),
        params,
        sig,
      ),
    ).toBeNull();
  });
});
