// SPDX-License-Identifier: Elastic-2.0
//
// SMS providers normalize the destination to E.164 at the send boundary:
// stored numbers usually omit the "+1" country code, so the provider
// prefixes it before handing the number to Twilio / TextLink.

import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import { createTextLinkSmsProvider, createTwilioSmsProvider } from '../sms/provider';

const log = { info() {}, error() {}, warn() {}, debug() {} } as unknown as Logger;

function okFetch(capture: { url?: string; body?: string }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capture.url = url;
    capture.body = typeof init?.body === 'string' ? init.body : String(init?.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ sid: 'SM1', id: 'TL1' }),
    } as Response;
  }) as unknown as typeof fetch;
}

describe('SMS provider phone normalization', () => {
  it('twilio: prefixes +1 for a bare 10-digit US number', async () => {
    const cap: { body?: string } = {};
    const p = createTwilioSmsProvider(
      { accountSid: 'AC', authToken: 't', from: '+15550000000', fetchImpl: okFetch(cap) },
      log,
    );
    await p.send({ to: '(312) 555-0148', body: 'hi' });
    expect(cap.body).toContain('To=%2B13125550148'); // %2B === '+'
  });

  it('textlink: prefixes +1 for a bare 10-digit US number', async () => {
    const cap: { body?: string } = {};
    const p = createTextLinkSmsProvider({ apiKey: 'k', fetchImpl: okFetch(cap) }, log);
    await p.send({ to: '3125550148', body: 'hi' });
    expect(JSON.parse(cap.body ?? '{}').to).toBe('+13125550148');
  });

  it('leaves an already-E.164 number unchanged', async () => {
    const cap: { body?: string } = {};
    const p = createTextLinkSmsProvider({ apiKey: 'k', fetchImpl: okFetch(cap) }, log);
    await p.send({ to: '+13125550148', body: 'hi' });
    expect(JSON.parse(cap.body ?? '{}').to).toBe('+13125550148');
  });

  it('falls back to the raw string when it is not a parseable US number', async () => {
    const cap: { body?: string } = {};
    const p = createTextLinkSmsProvider({ apiKey: 'k', fetchImpl: okFetch(cap) }, log);
    await p.send({ to: 'not-a-phone', body: 'hi' });
    expect(JSON.parse(cap.body ?? '{}').to).toBe('not-a-phone');
  });
});
