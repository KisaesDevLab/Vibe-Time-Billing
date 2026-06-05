// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase 2 — createSignatureDocument drives the SHARED OpenSign client with
// multi-signer + placeholder payloads. No live sidecar: a mocked fetch
// captures the createdocumentfromapp body so we can assert the document
// carries one Signers pointer per signer and Placeholders built by the one
// coordinate adapter, and that each signer gets a distinct contact + URL.

import { describe, expect, it } from 'vitest';

import { createOpenSignClient } from '../esign/opensign-client';
import { createSignatureDocument } from '../signatures/opensign-document';

const LETTER = [{ pageNumber: 1, widthPt: 612, heightPt: 792 }];

interface Captured {
  document?: Record<string, unknown>;
}

function mockFetch(captured: Captured): typeof fetch {
  let contactSeq = 0;
  return (async (url: string, init?: RequestInit) => {
    const fn = url.split('/functions/')[1] ?? '';
    if (fn === 'loginuser') {
      return new Response(JSON.stringify({ result: { sessionToken: 'r:s', objectId: 'u1' } }));
    }
    if (fn === 'getUserDetails') {
      return new Response(JSON.stringify({ result: { objectId: 'ext1' } }));
    }
    if (fn === 'savefile') {
      return new Response(
        JSON.stringify({ result: { url: 'http://opensign:8080/files/src.pdf?token=jwt' } }),
      );
    }
    if (fn === 'savecontact') {
      contactSeq += 1;
      return new Response(JSON.stringify({ result: { objectId: `contact_${contactSeq}` } }));
    }
    if (fn === 'createdocumentfromapp') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { document?: Record<string, unknown> };
      captured.document = body.document;
      return new Response(JSON.stringify({ result: { objectId: 'doc_multi' } }));
    }
    return new Response(JSON.stringify({ result: {} }));
  }) as unknown as typeof fetch;
}

function client(captured: Captured) {
  return createOpenSignClient({
    baseUrl: 'http://opensign:8080/app',
    appId: 'opensign',
    masterKey: 'mk',
    publicUrl: 'https://os.example',
    apiEmail: 'api@firm.example',
    apiPassword: 'pw',
    fetchImpl: mockFetch(captured),
  });
}

describe('createSignatureDocument (phase 2)', () => {
  it('creates a multi-signer, field-placed document and returns per-signer URLs', async () => {
    const captured: Captured = {};
    const result = await createSignatureDocument(client(captured), {
      title: '8879-S 2025',
      pdfBytes: Buffer.from('%PDF-1.4 fake'),
      signers: [
        { signerId: 's1', name: 'Pat Officer', email: 'pat@co.example', role: 'officer' },
        { signerId: 's2', name: 'Dana ERO', email: 'dana@firm.example', role: 'ero' },
      ],
      placements: [
        {
          signerId: 's1',
          fieldType: 'signature',
          pageNumber: 1,
          nx: 0.1,
          ny: 0.7,
          nw: 0.3,
          nh: 0.05,
        },
        { signerId: 's1', fieldType: 'date', pageNumber: 1, nx: 0.5, ny: 0.7, nw: 0.15, nh: 0.04 },
        {
          signerId: 's2',
          fieldType: 'signature',
          pageNumber: 1,
          nx: 0.1,
          ny: 0.85,
          nw: 0.3,
          nh: 0.05,
        },
      ],
      geometry: LETTER,
    });

    expect(result.opensignDocumentId).toBe('doc_multi');
    expect(result.signers).toHaveLength(2);
    expect(result.signers[0]).toEqual({
      signerId: 's1',
      opensignContactId: 'contact_1',
      signingUrl: 'https://os.example/load/recipientSignPdf/doc_multi/contact_1',
    });
    expect(result.signers[1]!.opensignContactId).toBe('contact_2');

    // The createdocumentfromapp body carries one Signers pointer per signer
    // and adapter-built Placeholders (one per signer, grouped by page).
    const doc = captured.document!;
    expect(doc['Name']).toBe('8879-S 2025');
    expect(doc['URL']).toBe('http://opensign:8080/files/src.pdf?token=jwt');
    const signers = doc['Signers'] as Array<{ objectId: string; className: string }>;
    expect(signers.map((s) => s.objectId)).toEqual(['contact_1', 'contact_2']);
    expect(signers[0]!.className).toBe('contracts_Contactbook');

    const placeholders = doc['Placeholders'] as Array<{
      signerObjId: string;
      placeHolder: Array<{ pageNumber: number; pos: unknown[] }>;
    }>;
    expect(placeholders).toHaveLength(2);
    // signer 1: signature + date both on page 1 → one page group, two pos.
    expect(placeholders[0]!.signerObjId).toBe('contact_1');
    expect(placeholders[0]!.placeHolder).toHaveLength(1);
    expect(placeholders[0]!.placeHolder[0]!.pos).toHaveLength(2);
    // signer 2: one field on page 1.
    expect(placeholders[1]!.signerObjId).toBe('contact_2');
    expect(placeholders[1]!.placeHolder[0]!.pos).toHaveLength(1);
  });

  it('rejects an empty signer list', async () => {
    const captured: Captured = {};
    await expect(
      createSignatureDocument(client(captured), {
        title: 'x',
        pdfBytes: Buffer.from('%PDF'),
        signers: [],
        placements: [],
        geometry: LETTER,
      }),
    ).rejects.toThrow('signature_document_no_signers');
  });
});
