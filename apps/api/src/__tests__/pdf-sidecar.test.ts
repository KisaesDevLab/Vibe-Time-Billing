// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P14 — PDF sidecar passthrough tests.
//
// We never invoke real Puppeteer here. The renderer is tested in
// sidecar-passthrough mode (PDF_SIDECAR_URL set or sidecarUrl opt
// passed) so the only network edge is the injected fetch.

import { describe, expect, it } from 'vitest';
import { renderHtmlToPdf } from '../pdf/render';

function captureFetch(opts: { status?: number; body?: Buffer } = {}): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init as RequestInit | undefined });
    const buf = opts.body ?? Buffer.from('%PDF-1.4\n%fake\n');
    return new Response(buf, { status: opts.status ?? 200 });
  };
  return { fetch: fetchImpl, calls };
}

describe('P14 — PDF sidecar passthrough', () => {
  it('POSTs html to the configured sidecar and returns bytes', async () => {
    const { fetch, calls } = captureFetch();
    const buf = await renderHtmlToPdf('<h1>Test</h1>', {
      sidecarUrl: 'http://pdf-sidecar:8080/render',
      fetchImpl: fetch,
    });
    expect(buf.toString('utf8', 0, 5)).toBe('%PDF-');
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('http://pdf-sidecar:8080/render');
    expect(calls[0]!.init?.method).toBe('POST');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.html).toBe('<h1>Test</h1>');
    expect(body.options.format).toBe('Letter');
  });

  it('throws on non-2xx response', async () => {
    const { fetch } = captureFetch({ status: 500 });
    await expect(
      renderHtmlToPdf('<h1>Test</h1>', {
        sidecarUrl: 'http://pdf-sidecar:8080/render',
        fetchImpl: fetch,
      }),
    ).rejects.toThrow(/pdf_sidecar_failed: 500/);
  });

  it('aborts after timeout', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
        // never resolves
        void resolve;
      });
    await expect(
      renderHtmlToPdf('<h1>Test</h1>', {
        sidecarUrl: 'http://pdf-sidecar:8080/render',
        fetchImpl,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
