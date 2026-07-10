// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// EmailIt provider is wired through the config schema, masking, and factory.
// Send path targets API v2 (v1 sunset Dec 2025): base64/URL attachments,
// reply_to, tracking off, one retry on 429. URL attachments ride the
// mail-asset store + its public token route.

import { describe, expect, it } from 'vitest';
import { pino } from 'pino';

import { EmailConfig, maskEmailConfig } from '../messaging/config';
import { buildMailProvider } from '../messaging/factory';
import { createEmailItProvider } from '../mail/provider';
import { createMailAssetStore } from '../mail/asset-store';

const log = pino({ enabled: false });

/** fetch stub returning queued statuses; records each request URL + body. */
function fetchStub(statuses: number[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const impl = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const status = statuses[Math.min(i, statuses.length - 1)]!;
    i += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ id: 'em_test123' }),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('EmailIt email provider', () => {
  it('parses, masks (no secret echoed), and builds a provider', () => {
    const parsed = EmailConfig.parse({
      provider: 'emailit',
      from: 'billing@firm.example',
      apiKey: 'secret-key-1234',
    });
    expect(parsed.provider).toBe('emailit');

    const masked = maskEmailConfig(parsed);
    expect(masked.provider).toBe('emailit');
    expect(masked.apiKeyMasked).not.toContain('secret-key-1234');
    expect((masked as { apiKey?: string }).apiKey).toBeUndefined();

    const provider = buildMailProvider(parsed, pino({ enabled: false }));
    expect(provider.id).toBe('emailit');
  });

  it('rejects an emailit config missing the apiKey', () => {
    const r = EmailConfig.safeParse({ provider: 'emailit', from: 'a@b.example' });
    expect(r.success).toBe(false);
  });

  it('posts to the v2 endpoint with base64 attachments, reply_to, and tracking off', async () => {
    const stub = fetchStub([200]);
    const provider = createEmailItProvider(
      { apiKey: 'k', from: 'billing@firm.example', fetchImpl: stub.impl },
      log,
    );
    const pdf = Buffer.from('%PDF-1.7 fake');
    const r = await provider.send({
      to: 'client@example.com',
      subject: 'Statement',
      body: 'See attached.',
      html: '<p>See attached.</p>',
      replyTo: 'frontdesk@firm.example',
      attachments: [{ filename: 'statement.pdf', content: pdf, contentType: 'application/pdf' }],
    });
    expect(r).toEqual({ ok: true, messageId: 'em_test123' });
    expect(stub.calls).toHaveLength(1);
    const { url, body } = stub.calls[0]!;
    expect(url).toBe('https://api.emailit.com/v2/emails');
    expect(body['to']).toEqual(['client@example.com']);
    expect(body['reply_to']).toBe('frontdesk@firm.example');
    expect(body['tracking']).toBe(false);
    expect(body['attachments']).toEqual([
      {
        filename: 'statement.pdf',
        content: pdf.toString('base64'),
        content_type: 'application/pdf',
      },
    ]);
  });

  it('retries once on 429 and succeeds', async () => {
    const stub = fetchStub([429, 200]);
    const provider = createEmailItProvider(
      { apiKey: 'k', from: 'a@b.example', fetchImpl: stub.impl, sleepImpl: async () => {} },
      log,
    );
    const r = await provider.send({ to: 'c@d.example', subject: 's', body: 'b' });
    expect(r.ok).toBe(true);
    expect(stub.calls).toHaveLength(2);
  });

  it('gives up after one 429 retry', async () => {
    const stub = fetchStub([429, 429]);
    const provider = createEmailItProvider(
      { apiKey: 'k', from: 'a@b.example', fetchImpl: stub.impl, sleepImpl: async () => {} },
      log,
    );
    const r = await provider.send({ to: 'c@d.example', subject: 's', body: 'b' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('429');
    expect(stub.calls).toHaveLength(2);
  });

  it('sends url attachments when a stash hook is configured', async () => {
    const stub = fetchStub([200]);
    const store = createMailAssetStore({ baseUrl: 'https://portal.firm.example' });
    const provider = createEmailItProvider(
      {
        apiKey: 'k',
        from: 'a@b.example',
        fetchImpl: stub.impl,
        stashAttachmentUrl: (att) => store.stash(att),
      },
      log,
    );
    const pdf = Buffer.from('%PDF-1.7 fake');
    const r = await provider.send({
      to: 'c@d.example',
      subject: 's',
      body: 'b',
      attachments: [{ filename: 'invoice.pdf', content: pdf, contentType: 'application/pdf' }],
    });
    expect(r.ok).toBe(true);
    const atts = stub.calls[0]!.body['attachments'] as Array<Record<string, string>>;
    expect(atts).toHaveLength(1);
    expect(atts[0]!['filename']).toBe('invoice.pdf');
    expect(atts[0]!['content']).toBeUndefined();
    const stashedUrl = atts[0]!['url']!;
    expect(stashedUrl).toMatch(/^https:\/\/portal\.firm\.example\/api\/mail-assets\/[a-f0-9]{64}$/);
    // The stashed URL round-trips through the store the route serves from.
    const token = stashedUrl.split('/').pop()!;
    const asset = store.get(token);
    expect(asset?.contentType).toBe('application/pdf');
    expect(asset?.content.equals(pdf)).toBe(true);
  });

  it('falls back to inline base64 when the stash hook throws', async () => {
    const stub = fetchStub([200]);
    const provider = createEmailItProvider(
      {
        apiKey: 'k',
        from: 'a@b.example',
        fetchImpl: stub.impl,
        stashAttachmentUrl: () => {
          throw new Error('store full');
        },
      },
      log,
    );
    const pdf = Buffer.from('%PDF-1.7 fake');
    const r = await provider.send({
      to: 'c@d.example',
      subject: 's',
      body: 'b',
      attachments: [{ filename: 'invoice.pdf', content: pdf, contentType: 'application/pdf' }],
    });
    expect(r.ok).toBe(true);
    const atts = stub.calls[0]!.body['attachments'] as Array<Record<string, string>>;
    expect(atts[0]!['url']).toBeUndefined();
    expect(atts[0]!['content']).toBe(pdf.toString('base64'));
  });
});

describe('mail asset store', () => {
  it('expires entries after the TTL', () => {
    let t = 1_000;
    const store = createMailAssetStore({
      baseUrl: 'https://x.example',
      ttlMs: 100,
      nowImpl: () => t,
    });
    const url = store.stash({ filename: 'a.pdf', content: Buffer.from('x') });
    const token = url.split('/').pop()!;
    expect(store.get(token)).not.toBeNull();
    t += 101;
    expect(store.get(token)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('evicts the oldest entry beyond maxEntries', () => {
    const store = createMailAssetStore({ baseUrl: 'https://x.example', maxEntries: 2 });
    const first = store.stash({ filename: '1.pdf', content: Buffer.from('1') });
    store.stash({ filename: '2.pdf', content: Buffer.from('2') });
    store.stash({ filename: '3.pdf', content: Buffer.from('3') });
    expect(store.size()).toBe(2);
    expect(store.get(first.split('/').pop()!)).toBeNull();
  });

  it('defaults contentType to application/octet-stream', () => {
    const store = createMailAssetStore({ baseUrl: 'https://x.example' });
    const token = store
      .stash({ filename: 'raw.bin', content: Buffer.from('b') })
      .split('/')
      .pop()!;
    expect(store.get(token)?.contentType).toBe('application/octet-stream');
  });
});
