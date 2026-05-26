// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P15 — E-signature provider tests.

import { describe, expect, it } from 'vitest';

import { createNativeProvider, createOpenSignProvider } from '../esign/provider';

describe('P15 — NativeProvider', () => {
  it('createEnvelope returns PENDING with a native_ prefixed id', async () => {
    const p = createNativeProvider();
    const e = await p.createEnvelope({
      proposalId: '11111111-1111-1111-1111-111111111111',
      signerName: 'Jane',
      signerEmail: 'jane@x.com',
      documentTitle: 'Engagement Letter',
      documentHtml: '<p>terms</p>',
    });
    expect(e.providerId).toBe('native');
    expect(e.envelopeId.startsWith('nat_')).toBe(true);
    expect(e.status).toBe('PENDING');
    expect(e.signedAt).toBeNull();
  });

  it('sign with typed name transitions to SIGNED', async () => {
    const p = createNativeProvider();
    const created = await p.createEnvelope({
      proposalId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      signerName: 'A',
      signerEmail: 'a@x.com',
      documentTitle: 't',
      documentHtml: '<p>t</p>',
    });
    const signed = await p.sign({
      envelopeId: created.envelopeId,
      typedName: 'A',
      signerIp: '127.0.0.1',
      signerUa: 'test',
      signedAt: new Date(),
    });
    expect(signed.status).toBe('SIGNED');
    expect(signed.signedAt).not.toBeNull();
  });

  it('sign rejects empty typed name', async () => {
    const p = createNativeProvider();
    const e = await p.createEnvelope({
      proposalId: 'p',
      signerName: 'A',
      signerEmail: 'a@x.com',
      documentTitle: 't',
      documentHtml: '<p>t</p>',
    });
    await expect(
      p.sign({
        envelopeId: e.envelopeId,
        typedName: '   ',
        signerIp: null,
        signerUa: null,
        signedAt: new Date(),
      }),
    ).rejects.toThrow(/typed_name_required/);
  });

  it('sign rejects when envelope already SIGNED', async () => {
    const p = createNativeProvider();
    const e = await p.createEnvelope({
      proposalId: 'p',
      signerName: 'A',
      signerEmail: 'a@x.com',
      documentTitle: 't',
      documentHtml: '<p>t</p>',
    });
    await p.sign({
      envelopeId: e.envelopeId,
      typedName: 'A',
      signerIp: null,
      signerUa: null,
      signedAt: new Date(),
    });
    await expect(
      p.sign({
        envelopeId: e.envelopeId,
        typedName: 'B',
        signerIp: null,
        signerUa: null,
        signedAt: new Date(),
      }),
    ).rejects.toThrow(/envelope_not_signable/);
  });

  it('sign rejects malicious SVG via CP8 sanitizer', async () => {
    const p = createNativeProvider();
    const e = await p.createEnvelope({
      proposalId: 'p',
      signerName: 'A',
      signerEmail: 'a@x.com',
      documentTitle: 't',
      documentHtml: '<p>t</p>',
    });
    await expect(
      p.sign({
        envelopeId: e.envelopeId,
        typedName: 'A',
        drawnSvg: '<svg><script>alert(1)</script></svg>',
        signerIp: null,
        signerUa: null,
        signedAt: new Date(),
      }),
    ).rejects.toThrow(/invalid_signature_svg/);
  });

  it('getStatus returns the current envelope', async () => {
    const p = createNativeProvider();
    const e = await p.createEnvelope({
      proposalId: 'p',
      signerName: 'A',
      signerEmail: 'a@x.com',
      documentTitle: 't',
      documentHtml: '<p>t</p>',
    });
    const status = await p.getStatus(e.envelopeId);
    expect(status.envelopeId).toBe(e.envelopeId);
  });

  it('sign + getStatus on unknown id throws', async () => {
    const p = createNativeProvider();
    await expect(p.getStatus('not-real')).rejects.toThrow(/envelope_not_found/);
  });
});

describe('P15 — OpenSignProvider', () => {
  it('createEnvelope POSTs to sidecar with bearer + body', async () => {
    let calledUrl = '';
    let calledBody = '';
    let calledAuth = '';
    const fetchImpl: typeof fetch = (async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledBody = String(init.body);
      calledAuth = (init.headers as Record<string, string>)?.['Authorization'] ?? '';
      return new Response(
        JSON.stringify({
          id: 'env_123',
          status: 'pending',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080',
      sharedSecret: 'shh',
      fetchImpl,
    });
    const e = await p.createEnvelope({
      proposalId: 'p-1',
      signerName: 'Jane',
      signerEmail: 'jane@x.com',
      documentTitle: 'Letter',
      documentHtml: '<p>terms</p>',
    });
    expect(e.providerId).toBe('opensign');
    expect(e.envelopeId).toBe('env_123');
    expect(e.status).toBe('PENDING');
    expect(calledUrl).toBe('http://opensign:8080/api/envelopes');
    expect(calledAuth).toBe('Bearer shh');
    expect(calledBody).toContain('"proposalId":"p-1"');
    expect(calledBody).toContain('"title":"Letter"');
  });

  it('sign() throws — staff side never invokes it', async () => {
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080',
      sharedSecret: 's',
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });
    await expect(
      p.sign({
        envelopeId: 'env_1',
        typedName: 'A',
        signerIp: null,
        signerUa: null,
        signedAt: new Date(),
      }),
    ).rejects.toThrow(/sign_not_directly_invokable/);
  });

  it('getStatus parses signed envelope including cert key', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'env_signed',
          status: 'signed',
          signedAt: '2026-04-15T15:00:00Z',
          certificateObjectKey: 'opensign-docs/firm-x/cert.pdf',
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080',
      sharedSecret: 's',
      fetchImpl,
    });
    const e = await p.getStatus('env_signed');
    expect(e.status).toBe('SIGNED');
    expect(e.signedAt).not.toBeNull();
    expect(e.certificateObjectKey).toBe('opensign-docs/firm-x/cert.pdf');
  });

  it('throws on sidecar 5xx', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: 'kaboom' }), {
        status: 500,
      })) as unknown as typeof fetch;
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080',
      sharedSecret: 's',
      fetchImpl,
    });
    await expect(p.getStatus('e')).rejects.toThrow(/kaboom/);
  });
});
