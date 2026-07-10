// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// ensureInOfficeDocument branch behavior: an already-sent request returns the
// existing per-signer signing URLs; a terminal request is refused. (The
// draft→create path shares its persist logic with sendSignatureRequest, which
// is covered by signatures-send-reconcile.)

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { signatureRequests, signatureSigners } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { ensureInOfficeDocument } from '../signatures/send';
import type { OpenSignClient } from '../esign/opensign-client';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const client = { publicUrl: 'https://os.example' } as unknown as OpenSignClient;
const storage = {} as unknown as StorageClient;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

async function makeRequest(status: string): Promise<string> {
  const [req] = await harness.db
    .insert(signatureRequests)
    .values({
      firmId: seed.firmId,
      title: 'Smith 2024 1040 — signatures',
      formType: '8879',
      status,
      signingMode: 'in_person',
      opensignDocumentId: status === 'draft' ? null : 'doc_x',
      signerCount: 1,
    })
    .returning({ id: signatureRequests.id });
  return req!.id;
}

describe('ensureInOfficeDocument', () => {
  it('returns existing per-signer signing URLs when already sent', async () => {
    const requestId = await makeRequest('sent');
    const [signer] = await harness.db
      .insert(signatureSigners)
      .values({
        requestId,
        name: 'Pat Smith',
        email: 'pat@s.example',
        role: 'taxpayer',
        order: 1,
        opensignSignerId: 'contact_y',
      })
      .returning({ id: signatureSigners.id });

    const out = await ensureInOfficeDocument(
      { db: harness.db, storage, client },
      { requestId, firmId: seed.firmId, actor: 'test' },
    );
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') return;
    expect(out.signingUrlBySignerId[signer!.id]).toBe(
      'https://os.example/load/recipientSignPdf/doc_x/contact_y',
    );
  });

  it('refuses a terminal request', async () => {
    const requestId = await makeRequest('completed');
    const out = await ensureInOfficeDocument(
      { db: harness.db, storage, client },
      { requestId, firmId: seed.firmId, actor: 'test' },
    );
    expect(out.kind).toBe('terminal');
  });

  it('is not_found for another firm', async () => {
    const requestId = await makeRequest('sent');
    const out = await ensureInOfficeDocument(
      { db: harness.db, storage, client },
      { requestId, firmId: '00000000-0000-0000-0000-000000000000', actor: 'test' },
    );
    expect(out.kind).toBe('not_found');
  });
});
