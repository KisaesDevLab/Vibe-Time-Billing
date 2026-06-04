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

describe('P15 — OpenSignProvider (real Parse cloud-function contract)', () => {
  // A fetch stub that routes by cloud-function name. Each call hits
  // `${base}/functions/<fn>` and returns the Parse `{ result }` envelope.
  function routedFetch(
    handlers: Record<string, (body: Record<string, unknown>, init: RequestInit) => unknown>,
    capture?: {
      calls: { fn: string; headers: Record<string, string>; body: Record<string, unknown> }[];
    },
  ): typeof fetch {
    return (async (url: string, init: RequestInit) => {
      const fn = url.split('/functions/')[1] ?? '';
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      capture?.calls.push({ fn, headers: init.headers as Record<string, string>, body });
      const handler = handlers[fn];
      if (!handler) return new Response(JSON.stringify({ result: {} }), { status: 200 });
      const result = handler(body, init);
      return new Response(JSON.stringify({ result }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('createEnvelope runs the real flow: loginuser → savefile → savecontact → createdocumentfromapp', async () => {
    const cap = {
      calls: [] as { fn: string; headers: Record<string, string>; body: Record<string, unknown> }[],
    };
    const fetchImpl = routedFetch(
      {
        loginuser: () => ({ sessionToken: 'r:sess123', objectId: 'user_1' }),
        getUserDetails: () => ({ objectId: 'extuser_1' }),
        savefile: () => ({ url: 'http://opensign:8080/files/abc.pdf?token=jwt' }),
        savecontact: () => ({ objectId: 'contact_9' }),
        createdocumentfromapp: () => ({ objectId: 'doc_123' }),
      },
      cap,
    );
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080/app',
      appId: 'opensign',
      masterKey: 'mk',
      publicUrl: 'https://opensign.example',
      apiEmail: 'api@firm.example',
      apiPassword: 'pw',
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
    expect(e.envelopeId).toBe('doc_123');
    expect(e.status).toBe('PENDING');
    expect(e.signingUrl).toBe('https://opensign.example/load/recipientSignPdf/doc_123/contact_9');

    // loginuser carries the master key; the write paths carry the session.
    const login = cap.calls.find((c) => c.fn === 'loginuser')!;
    expect(login.headers['X-Parse-Application-Id']).toBe('opensign');
    expect(login.headers['X-Parse-Master-Key']).toBe('mk');
    const create = cap.calls.find((c) => c.fn === 'createdocumentfromapp')!;
    expect(create.headers['X-Parse-Session-Token']).toBe('r:sess123');
    const doc = create.body['document'] as Record<string, unknown>;
    expect(doc['URL']).toBe('http://opensign:8080/files/abc.pdf?token=jwt');
    expect(doc['ExtUserPtr']).toMatchObject({
      className: 'contracts_Users',
      objectId: 'extuser_1',
    });
  });

  it('createEnvelope throws clearly when the API account is unconfigured', async () => {
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080/app',
      appId: 'opensign',
      masterKey: 'mk',
      fetchImpl: routedFetch({}),
    });
    await expect(
      p.createEnvelope({
        proposalId: 'p-1',
        signerName: 'Jane',
        signerEmail: 'jane@x.com',
        documentTitle: 'Letter',
        documentHtml: '<p>x</p>',
      }),
    ).rejects.toThrow(/api_account_unconfigured/);
  });

  it('sign() throws — staff side never invokes it', async () => {
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080/app',
      appId: 'opensign',
      masterKey: 's',
      fetchImpl: routedFetch({}),
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

  it('getStatus maps a completed OpenSign document to SIGNED', async () => {
    const fetchImpl = routedFetch({
      getDocument: () => ({
        objectId: 'doc_signed',
        IsCompleted: true,
        AuditTrail: [{ Activity: 'Signed', SignedOn: '2026-04-15T15:00:00Z' }],
      }),
    });
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080/app',
      appId: 'opensign',
      masterKey: 's',
      fetchImpl,
    });
    const e = await p.getStatus('doc_signed');
    expect(e.status).toBe('SIGNED');
    expect(e.signedAt?.toISOString()).toBe('2026-04-15T15:00:00.000Z');
  });

  it('getStatus maps a declined OpenSign document to DECLINED', async () => {
    const fetchImpl = routedFetch({
      getDocument: () => ({ objectId: 'doc_d', IsDeclined: true }),
    });
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080/app',
      appId: 'opensign',
      masterKey: 's',
      fetchImpl,
    });
    const e = await p.getStatus('doc_d');
    expect(e.status).toBe('DECLINED');
  });

  it('throws on a soft Parse {error} result', async () => {
    const fetchImpl = routedFetch({
      getDocument: () => ({ error: "document deleted or you don't have access." }),
    });
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080/app',
      appId: 'opensign',
      masterKey: 's',
      fetchImpl,
    });
    await expect(p.getStatus('e')).rejects.toThrow(/don't have access/);
  });
});
