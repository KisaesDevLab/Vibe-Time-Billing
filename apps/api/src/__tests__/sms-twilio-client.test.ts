// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0233 — raw-fetch Twilio client: auth header selection (API key pair vs
// SID:token), Messaging Service sends, error mapping (retryable vs not),
// message paging via next_page_uri, and media fetch that follows the S3
// redirect WITHOUT forwarding the Authorization header.

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { TwilioApiError, createTwilioClient } from '../sms/twilio-client';

const log = pino({ enabled: false });
const AC = 'AC' + 'a'.repeat(32);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function stubFetch(
  handler: (call: Call) => {
    status: number;
    json?: unknown;
    headers?: Record<string, string>;
    bytes?: Buffer;
  },
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const r = handler(call);
    const hdrs = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => hdrs.get(k.toLowerCase()) ?? null },
      json: async () => r.json ?? {},
      arrayBuffer: async () => {
        const b = r.bytes ?? Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe('twilio client', () => {
  it('sends through the Messaging Service with SID:token auth', async () => {
    const { fetch, calls } = stubFetch(() => ({
      status: 201,
      json: { sid: 'SM1', status: 'queued', num_segments: '2' },
    }));
    const c = createTwilioClient({ accountSid: AC, authToken: 'tok', fetchImpl: fetch }, log);
    const r = await c.sendMessage({
      to: '+12025550100',
      body: 'hi',
      messagingServiceSid: 'MG1',
      statusCallback: 'https://x/api/sms/twilio/status',
    });
    expect(r).toEqual({ sid: 'SM1', status: 'queued', numSegments: 2 });
    const call = calls[0]!;
    expect(call.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages.json`);
    expect(call.body).toContain('MessagingServiceSid=MG1');
    expect(call.body).not.toContain('From=');
    expect(call.body).toContain('StatusCallback=');
    expect(call.headers['Authorization']).toBe(
      `Basic ${Buffer.from(`${AC}:tok`).toString('base64')}`,
    );
  });

  it('prefers the API key pair for auth when present', async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, json: { friendly_name: 'Firm' } }));
    const c = createTwilioClient(
      { accountSid: AC, authToken: 'tok', apiKeySid: 'SK1', apiKeySecret: 'sec', fetchImpl: fetch },
      log,
    );
    const r = await c.verifyCredentials();
    expect(r).toEqual({ ok: true, accountName: 'Firm' });
    expect(calls[0]!.headers['Authorization']).toBe(
      `Basic ${Buffer.from('SK1:sec').toString('base64')}`,
    );
  });

  it('maps Twilio errors with retryability', async () => {
    const { fetch } = stubFetch(() => ({
      status: 400,
      json: { code: 21610, message: 'Attempt to send to unsubscribed recipient' },
    }));
    const c = createTwilioClient({ accountSid: AC, authToken: 'tok', fetchImpl: fetch }, log);
    await expect(
      c.sendMessage({ to: '+1', body: 'x', messagingServiceSid: 'MG1' }),
    ).rejects.toMatchObject({
      name: 'TwilioApiError',
      code: 21610,
      retryable: false,
    });
    const { fetch: f429 } = stubFetch(() => ({
      status: 429,
      json: { code: 20429, message: 'slow' },
    }));
    const c2 = createTwilioClient({ accountSid: AC, authToken: 'tok', fetchImpl: f429 }, log);
    try {
      await c2.getMessage('SM1');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TwilioApiError);
      expect((err as TwilioApiError).retryable).toBe(true);
    }
  });

  it('pages through listMessages via next_page_uri', async () => {
    const { fetch, calls } = stubFetch((call) =>
      call.url.includes('Page=1')
        ? {
            status: 200,
            json: { messages: [{ sid: 'SM2', direction: 'inbound' }], next_page_uri: null },
          }
        : {
            status: 200,
            json: {
              messages: [
                { sid: 'SM1', direction: 'inbound', date_sent: 'Tue, 02 Sep 2026 10:00:00 +0000' },
              ],
              next_page_uri: `/2010-04-01/Accounts/${AC}/Messages.json?Page=1&PageToken=x`,
            },
          },
    );
    const c = createTwilioClient({ accountSid: AC, authToken: 'tok', fetchImpl: fetch }, log);
    const sids: string[] = [];
    for await (const m of c.listMessages({
      to: '+12025550100',
      dateSentAfter: new Date('2026-09-01T00:00:00Z'),
    })) {
      sids.push(m.sid);
    }
    expect(sids).toEqual(['SM1', 'SM2']);
    expect(calls[0]!.url).toContain('To=%2B12025550100');
    expect(calls[0]!.url).toContain('DateSent%3E=2026-09-01T00%3A00%3A00Z');
    expect(calls[1]!.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages.json?Page=1&PageToken=x`,
    );
  });

  it('fetchMedia follows the redirect without forwarding credentials', async () => {
    const { fetch, calls } = stubFetch((call) => {
      const headers: Record<string, string> = call.url.startsWith('https://api.twilio.com/')
        ? { Location: 'https://s3.example/blob?sig=1' }
        : { 'Content-Type': 'image/jpeg; charset=binary' };
      return call.url.startsWith('https://api.twilio.com/')
        ? { status: 307, headers }
        : { status: 200, headers, bytes: Buffer.from('JPEG') };
    });
    const c = createTwilioClient({ accountSid: AC, authToken: 'tok', fetchImpl: fetch }, log);
    const r = await c.fetchMedia(
      `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages/SM1/Media/ME1`,
    );
    expect(r.contentType).toBe('image/jpeg');
    expect(r.bytes.toString()).toBe('JPEG');
    expect(calls[0]!.headers['Authorization']).toBeDefined();
    expect(calls[1]!.url).toBe('https://s3.example/blob?sig=1');
    expect(calls[1]!.headers['Authorization']).toBeUndefined();
  });

  it('maps A2P compliance status', async () => {
    const mk = (compliance: unknown) => {
      const { fetch } = stubFetch(() => ({ status: 200, json: { compliance } }));
      return createTwilioClient({ accountSid: AC, authToken: 'tok', fetchImpl: fetch }, log);
    };
    expect(await mk([{ campaign_status: 'VERIFIED' }]).getA2pStatus('MG1')).toBe('registered');
    expect(await mk([{ campaign_status: 'IN_PROGRESS' }]).getA2pStatus('MG1')).toBe('pending');
    expect(await mk([]).getA2pStatus('MG1')).toBe('unregistered');
    const { fetch: bad } = stubFetch(() => ({ status: 500, json: { message: 'boom' } }));
    expect(
      await createTwilioClient(
        { accountSid: AC, authToken: 'tok', fetchImpl: bad },
        log,
      ).getA2pStatus('MG1'),
    ).toBe('unknown');
  });
});
