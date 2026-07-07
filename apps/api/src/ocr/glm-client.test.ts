// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import { extractGeneralInfo, extractJsonObject, type GlmOcrConfig } from './glm-client';

const cfg: GlmOcrConfig = {
  baseUrl: 'http://192.168.68.105:8082',
  model: 'glm-ocr',
  timeoutMs: 5000,
};

function ok(content: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
}

describe('glm-ocr client', () => {
  it('posts the image + schema prompt to /v1/chat/completions and validates JSON', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"entityForm":"1040","lastName":"Smith","firstName":"Jane"}' } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const res = await extractGeneralInfo(cfg, 'BASE64PNG', { fetchImpl: fakeFetch });

    expect(captured!.url).toBe('http://192.168.68.105:8082/v1/chat/completions');
    const body = JSON.parse(captured!.init.body as string) as {
      model: string;
      temperature: number;
      messages: Array<{
        content: Array<{ type: string; image_url?: { url: string }; text?: string }>;
      }>;
    };
    expect(body.model).toBe('glm-ocr');
    expect(body.temperature).toBe(0);
    const parts = body.messages[0]!.content;
    expect(parts[0]!.image_url!.url).toBe('data:image/png;base64,BASE64PNG');
    expect(parts[1]!.text).toContain('UltraTax');
    // The JSON schema must never solicit tax-id fields (it may still
    // instruct the model in prose to exclude them).
    expect(parts[1]!.text).not.toContain('"ssn"');
    expect(parts[1]!.text).not.toContain('"ein"');
    expect(res.extracted.entityForm).toBe('1040');
    expect(res.extracted.lastName).toBe('Smith');
    // Missing fields default to '' rather than undefined.
    expect(res.extracted.city).toBe('');
  });

  it('appends /v1 only when the base URL omits it', async () => {
    let url = '';
    const spy = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    await extractGeneralInfo({ ...cfg, baseUrl: 'http://host:8082/v1' }, 'X', { fetchImpl: spy });
    expect(url).toBe('http://host:8082/v1/chat/completions');
  });

  it('strips code fences and surrounding prose before parsing', async () => {
    const content = 'Here you go:\n```json\n{"clientName":"Acme LLC"}\n```\nThanks!';
    const res = await extractGeneralInfo(cfg, 'X', { fetchImpl: ok(content) });
    expect(res.extracted.clientName).toBe('Acme LLC');
  });

  it('retries on 5xx then succeeds', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      if (calls < 3) return new Response('busy', { status: 503 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"clientName":"OK"}' } }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as unknown as typeof fetch;
    const res = await extractGeneralInfo(cfg, 'X', { fetchImpl: flaky });
    expect(calls).toBe(3);
    expect(res.extracted.clientName).toBe('OK');
  });

  it('throws on unparseable content', async () => {
    await expect(
      extractGeneralInfo(cfg, 'X', { fetchImpl: ok('not json at all') }),
    ).rejects.toThrow(/glm_ocr_invalid_json/);
  });

  it('extractJsonObject isolates the outermost object', () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('prefix {"a":{"b":2}} suffix')).toBe('{"a":{"b":2}}');
  });
});
