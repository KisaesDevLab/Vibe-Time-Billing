// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { listPrinters, listTemplates, printPdf, printWithTemplate } from './client';
import type { ResolvedPrintGateway } from './config';

const cfg: ResolvedPrintGateway = {
  baseUrl: 'http://printer-host:8080',
  apiKey: 'secret-abc',
  enabled: true,
  defaultPrinterId: null,
  autoPrintSignatureConfirmation: false,
};

describe('print-gateway client', () => {
  it('printPdf posts base64 content + bearer + idempotency key', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ id: 'job-7' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const res = await printPdf(
      cfg,
      {
        printerId: 3,
        pdf: Buffer.from('PDFDATA'),
        copies: 2,
        media: 'Letter',
        idempotencyKey: 'k1',
      },
      { fetchImpl: fakeFetch },
    );

    expect(res.jobId).toBe('job-7');
    expect(captured!.url).toBe('http://printer-host:8080/v1/print/file');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-abc');
    expect(headers['Idempotency-Key']).toBe('k1');
    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      printer: 3,
      content_type: 'pdf',
      copies: 2,
      media: 'Letter',
      content: Buffer.from('PDFDATA').toString('base64'),
    });
  });

  it('printPdf throws on non-2xx', async () => {
    const fakeFetch = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(
      printPdf(cfg, { printerId: 1, pdf: Buffer.from('x') }, { fetchImpl: fakeFetch }),
    ).rejects.toThrow(/gateway_print_failed_500/);
  });

  it('printWithTemplate posts to /v1/print with template id + data', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ id: 'job-9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const res = await printWithTemplate(
      cfg,
      { printerId: 4, templateId: 7, data: { form_code: '1040' }, copies: 2, idempotencyKey: 'k2' },
      { fetchImpl: fakeFetch },
    );

    expect(res.jobId).toBe('job-9');
    expect(captured!.url).toBe('http://printer-host:8080/v1/print');
    expect((captured!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('k2');
    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ printer: 4, template: 7, data: { form_code: '1040' }, copies: 2 });
  });

  it('listTemplates normalizes the template array', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify([{ id: 7, name: '1040 cover' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    expect(await listTemplates(cfg, { fetchImpl: fakeFetch })).toEqual([
      { id: 7, name: '1040 cover' },
    ]);
  });

  it('listPrinters normalizes the printer array', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify([
          { id: 1, name: 'Front desk' },
          { id: '2', name: 'Back' },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )) as unknown as typeof fetch;
    const printers = await listPrinters(cfg, { fetchImpl: fakeFetch });
    expect(printers).toEqual([
      { id: 1, name: 'Front desk' },
      { id: 2, name: 'Back' },
    ]);
  });
});
