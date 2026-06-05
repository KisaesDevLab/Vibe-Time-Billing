// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase 7 (production) — the OpenSign webhook drives signature_requests
// end-to-end. A `completed` event for a document we own reconciles the
// request to 'completed' (and stores the signed PDF); an event for an
// unknown document is acknowledged + ignored and never touches the
// signatures tables. Disjoint id space from proposal envelopes, so the two
// completion paths can't collide.

import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { signatureRequests, signatureSigners } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createOpenSignWebhookRouter } from '../webhooks/opensign';
import type { OpenSignClient, ParseDoc } from '../esign/opensign-client';

const WEBHOOK_SECRET = 'sig-webhook-secret';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

function memStorage(): StorageClient & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    kind: 'mock',
    objects,
    async put(key: string, body: Buffer | Readable) {
      objects.set(key, Buffer.isBuffer(body) ? body : Buffer.alloc(0));
      return { etag: 'e' };
    },
    async get(key: string) {
      const buf = objects.get(key);
      if (!buf) throw new Error('not_found');
      return { body: Readable.from(buf), meta: { key, size: buf.byteLength } };
    },
    async head() {
      return null;
    },
    list: () => {
      throw new Error('ni');
    },
    delete: async () => undefined,
    copy: async () => ({ etag: 'x' }),
    presignGet: async () => 'mock://g',
    presignPut: async () => 'mock://p',
  } as unknown as StorageClient & { objects: Map<string, Buffer> };
}

function mockClient(doc: () => ParseDoc): OpenSignClient {
  return {
    base: 'http://os',
    appId: 'opensign',
    publicUrl: 'https://os.example',
    callFn: async () => ({}),
    ensureSession: async () => ({ sessionToken: 's', userId: 'u', extUserId: 'e' }),
    ptr: (className, objectId) => ({ __type: 'Pointer' as const, className, objectId }),
    saveFile: async () => ({ url: 'u' }),
    saveContact: async () => ({ objectId: 'c' }),
    getDocument: async () => doc(),
    generateCertificate: async () => ({}),
    fetchPdfUrl: async () => ({ body: Buffer.from('%PDF signed'), contentType: 'application/pdf' }),
  };
}

// In production both completion paths are wired. A proposal-provider stub
// lets an unknown-document event fall through to completeOpenSignEnvelope,
// which finds no proposal signature row and returns ignored (→ 200) — never
// calling the provider for an unknown envelope.
const stubProvider = {
  id: 'opensign' as const,
  createEnvelope: async () => {
    throw new Error('unused');
  },
  sign: async () => {
    throw new Error('unused');
  },
  getStatus: async () => {
    throw new Error('unused');
  },
  fetchCertificatePdf: async () => {
    throw new Error('unused');
  },
};

function buildApp(client: OpenSignClient, storage: StorageClient): express.Express {
  const app = express();
  app.use(
    '/api/webhooks/opensign',
    createOpenSignWebhookRouter({
      db: harness.db,
      provider: stubProvider,
      storage,
      webhookSecret: WEBHOOK_SECRET,
      hmacSeed: 'unused-here',
      openSignClient: client,
    }),
  );
  return app;
}

function post(app: express.Express, body: object) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  return request(app)
    .post('/api/webhooks/opensign')
    .set('Content-Type', 'application/json')
    .set('x-webhook-signature', sig)
    .send(raw);
}

async function seedSentRequest(documentId: string): Promise<string> {
  const [req] = await harness.db
    .insert(signatureRequests)
    .values({
      firmId: seed.firmId,
      title: 'Webhook doc',
      status: 'sent',
      signerCount: 1,
      opensignDocumentId: documentId,
      sourceFileKey: `signatures/${seed.firmId}/x/source.pdf`,
    })
    .returning({ id: signatureRequests.id });
  await harness.db.insert(signatureSigners).values({
    requestId: req!.id,
    name: 'Signer',
    email: 'signer@co.example',
    opensignSignerId: 'contact_1',
  });
  return req!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('OpenSign webhook → signature_requests reconcile', () => {
  it('completes a request we own and stores the signed PDF', async () => {
    const storage = memStorage();
    const app = buildApp(
      mockClient(() => ({
        objectId: 'doc_wh_1',
        IsCompleted: true,
        SignedUrl: 'http://os/files/signed.pdf',
      })),
      storage,
    );
    const id = await seedSentRequest('doc_wh_1');

    const res = await post(app, {
      event: 'completed',
      objectId: 'doc_wh_1',
      file: 'http://os/files/signed.pdf',
    });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    const [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    expect(row!.status).toBe('completed');
    expect(row!.signedCount).toBe(1);
    expect(row!.signedFileUrl).toBe(`signatures/${seed.firmId}/${id}/signed.pdf`);
    expect(storage.objects.has(row!.signedFileUrl!)).toBe(true);
  });

  it('acknowledges + ignores an unknown document (no signatures touched)', async () => {
    const storage = memStorage();
    const app = buildApp(
      mockClient(() => ({ objectId: 'nope' })),
      storage,
    );
    await seedSentRequest('doc_known');

    const res = await post(app, { event: 'completed', objectId: 'totally-unknown' });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // Our known request is untouched.
    const [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.opensignDocumentId, 'doc_known'));
    expect(row!.status).toBe('sent');
  });

  it('rejects a bad HMAC signature (401)', async () => {
    const storage = memStorage();
    const app = buildApp(
      mockClient(() => ({ objectId: 'x' })),
      storage,
    );
    const res = await request(app)
      .post('/api/webhooks/opensign')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', 'deadbeef')
      .send(JSON.stringify({ event: 'completed', objectId: 'doc_wh_1' }));
    expect(res.status).toBe(401);
  });
});
