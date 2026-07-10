// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
      json: async () => ({ sid: 'SM1', ok: true }),
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

  it('textlink: posts to the correct endpoint with phone_number/text and +1', async () => {
    const cap: { url?: string; body?: string } = {};
    const p = createTextLinkSmsProvider({ apiKey: 'k', fetchImpl: okFetch(cap) }, log);
    const r = await p.send({ to: '3125550148', body: 'hi' });
    expect(cap.url).toBe('https://textlinksms.com/api/send-sms');
    const sent = JSON.parse(cap.body ?? '{}');
    expect(sent.phone_number).toBe('+13125550148');
    expect(sent.text).toBe('hi');
    expect(r.ok).toBe(true);
  });

  it('leaves an already-E.164 number unchanged', async () => {
    const cap: { body?: string } = {};
    const p = createTextLinkSmsProvider({ apiKey: 'k', fetchImpl: okFetch(cap) }, log);
    await p.send({ to: '+13125550148', body: 'hi' });
    expect(JSON.parse(cap.body ?? '{}').phone_number).toBe('+13125550148');
  });

  it('falls back to the raw string when it is not a parseable US number', async () => {
    const cap: { body?: string } = {};
    const p = createTextLinkSmsProvider({ apiKey: 'k', fetchImpl: okFetch(cap) }, log);
    await p.send({ to: 'not-a-phone', body: 'hi' });
    expect(JSON.parse(cap.body ?? '{}').phone_number).toBe('not-a-phone');
  });

  it('reports a logical failure (HTTP 200, ok:false) as an error', async () => {
    const failFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, message: 'Invalid API key' }),
      }) as Response) as unknown as typeof fetch;
    const p = createTextLinkSmsProvider({ apiKey: 'bad', fetchImpl: failFetch }, log);
    const r = await p.send({ to: '+13125550148', body: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Invalid API key');
  });
});
