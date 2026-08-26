// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 6+7 — source upload → transactional send → status reconciliation.
//   - upload captures geometry; send turns draft→sent, stamps the document
//     id + per-signer contact ids + an expiry;
//   - a failed OpenSign create rolls back (request stays draft);
//   - reconcile drives partially_signed → completed (+ stores signed PDF);
//   - past-expiry requests sweep to 'expired'.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';

import { clientFolders, files, signatureRequests, signatureSigners } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createSignaturesRouter } from '../signatures/routes';
import { reconcileSignatureRequestByDocument } from '../signatures/reconcile';
import { expireSignatureRequestIfDue } from '../signatures/reconcile';
import type { OpenSignClient, ParseDoc } from '../esign/opensign-client';

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
    async head(key: string) {
      const buf = objects.get(key);
      return buf ? { key, size: buf.byteLength } : null;
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

// Configurable mock OpenSign client.
function mockClient(opts: { failCreate?: boolean; doc?: () => ParseDoc } = {}): OpenSignClient {
  let contactSeq = 0;
  return {
    base: 'http://os',
    appId: 'opensign',
    publicUrl: 'https://os.example',
    async callFn(fn: string) {
      if (fn === 'createdocumentfromapp') {
        if (opts.failCreate) throw new Error('opensign_createdocumentfromapp_failed: boom');
        return { objectId: 'doc_sent_1' };
      }
      return {};
    },
    async ensureSession() {
      return { sessionToken: 's', userId: 'u1', extUserId: 'ext1' };
    },
    ptr(className: string, objectId: string) {
      return { __type: 'Pointer' as const, className, objectId };
    },
    async saveFile() {
      return { url: 'http://os/files/src.pdf' };
    },
    async saveContact() {
      contactSeq += 1;
      return { objectId: `contact_${contactSeq}` };
    },
    async getDocument() {
      return opts.doc ? opts.doc() : {};
    },
    async generateCertificate() {
      return {};
    },
    async fetchPdfUrl() {
      return { body: Buffer.from('%PDF signed'), contentType: 'application/pdf' };
    },
  };
}

async function onePagePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

interface SentMail {
  to: string;
  subject: string;
  body: string;
}

interface SentText {
  to: string;
  body: string;
}

function buildApp(
  client: OpenSignClient,
  storage: StorageClient,
  mailbox?: SentMail[],
  texts?: SentText[],
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  app.use(
    '/api/staff/signatures',
    createSignaturesRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
      storageClient: storage,
      openSignClient: client,
      sendEmail: mailbox
        ? async (a) => {
            mailbox.push({ to: a.to, subject: a.subject, body: a.body });
          }
        : undefined,
      sendSms: texts
        ? async (a) => {
            texts.push({ to: a.to, body: a.body });
          }
        : undefined,
    }),
  );
  return app;
}

// Create a draft + upload source + place a signature for each signer.
async function preparedRequest(app: express.Express): Promise<{ id: string; signerIds: string[] }> {
  const create = await request(app)
    .post('/api/staff/signatures')
    .send({
      title: 'Engagement Letter',
      clientId: seed.clientId,
      signers: [{ name: 'Client', email: 'client@co.example', role: 'client' }],
    });
  const id = create.body.id as string;

  const pdf = await onePagePdf();
  const up = await request(app)
    .post(`/api/staff/signatures/${id}/source`)
    .set('Content-Type', 'application/pdf')
    .send(pdf);
  expect(up.status).toBe(200);
  expect(up.body.pages).toBe(1);

  const detail = await request(app).get(`/api/staff/signatures/${id}`);
  const signerIds = (detail.body.signers as { id: string }[]).map((s) => s.id);
  const place = await request(app)
    .put(`/api/staff/signatures/${id}/placements`)
    .send({
      placements: signerIds.map((sid) => ({
        signerId: sid,
        fieldType: 'signature',
        pageNumber: 1,
        nx: 0.1,
        ny: 0.7,
        nw: 0.3,
        nh: 0.05,
      })),
    });
  expect(place.status).toBe(200);
  return { id, signerIds };
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('signatures send + reconcile (phase 6+7)', () => {
  it('uploads source, sends, and stamps document id + contacts + expiry', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient(), storage);
    const { id } = await preparedRequest(app);

    const send = await request(app).post(`/api/staff/signatures/${id}/send`);
    expect(send.status).toBe(200);
    expect(send.body.opensignDocumentId).toBe('doc_sent_1');

    const [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    expect(row!.status).toBe('sent');
    expect(row!.opensignDocumentId).toBe('doc_sent_1');
    expect(row!.sentAt).not.toBeNull();
    expect(row!.expiresAt).not.toBeNull();

    const signers = await harness.db
      .select()
      .from(signatureSigners)
      .where(eq(signatureSigners.requestId, id));
    expect(signers[0]!.opensignSignerId).toBe('contact_1');
  });

  it('rolls back to draft when the OpenSign create fails', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient({ failCreate: true }), storage);
    const { id } = await preparedRequest(app);

    const send = await request(app).post(`/api/staff/signatures/${id}/send`);
    expect(send.status).toBe(502);

    const [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    // No orphaned 'sent' row — stays a clean draft.
    expect(row!.status).toBe('draft');
    expect(row!.opensignDocumentId).toBeNull();
  });

  it('refuses to send without a source PDF', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient(), storage);
    const create = await request(app)
      .post('/api/staff/signatures')
      .send({ title: 'no source', signers: [{ name: 'A', email: 'a@x.example' }] });
    const id = create.body.id as string;
    const send = await request(app).post(`/api/staff/signatures/${id}/send`);
    expect(send.status).toBe(409);
    expect(send.body.error).toBe('no_source');
  });

  it('reconciles partially_signed then completed (+ stores signed PDF)', async () => {
    const storage = memStorage();
    // Two signers so a partial state is observable.
    const create = await request(buildApp(mockClient(), storage))
      .post('/api/staff/signatures')
      .send({
        title: 'Two-signer',
        signers: [
          { name: 'A', email: 'a@co.example' },
          { name: 'B', email: 'b@co.example' },
        ],
      });
    const id = create.body.id as string;
    // Send it through the normal path.
    const sendApp = buildApp(mockClient(), storage);
    const pdf = await onePagePdf();
    await request(sendApp)
      .post(`/api/staff/signatures/${id}/source`)
      .set('Content-Type', 'application/pdf')
      .send(pdf);
    const detail = await request(sendApp).get(`/api/staff/signatures/${id}`);
    const signerIds = (detail.body.signers as { id: string }[]).map((s) => s.id);
    await request(sendApp)
      .put(`/api/staff/signatures/${id}/placements`)
      .send({
        placements: signerIds.map((sid) => ({
          signerId: sid,
          fieldType: 'signature',
          pageNumber: 1,
          nx: 0.1,
          ny: 0.7,
          nw: 0.3,
          nh: 0.05,
        })),
      });
    await request(sendApp).post(`/api/staff/signatures/${id}/send`);

    // Only A signed → partially_signed.
    const partial = await reconcileSignatureRequestByDocument(
      {
        db: harness.db,
        storage,
        client: mockClient({
          doc: () => ({
            objectId: 'doc_sent_1',
            AuditTrail: [{ Activity: 'Signed', UserPtr: { Email: 'a@co.example' } }],
          }),
        }),
      },
      'doc_sent_1',
    );
    expect(partial.kind).toBe('updated');
    let [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    expect(row!.status).toBe('partially_signed');
    expect(row!.signedCount).toBe(1);

    // Now completed → completed + signed PDF stored.
    const done = await reconcileSignatureRequestByDocument(
      {
        db: harness.db,
        storage,
        client: mockClient({
          doc: () => ({
            objectId: 'doc_sent_1',
            IsCompleted: true,
            SignedUrl: 'http://os/files/signed.pdf',
          }),
        }),
      },
      'doc_sent_1',
    );
    expect(done.kind).toBe('updated');
    [row] = await harness.db.select().from(signatureRequests).where(eq(signatureRequests.id, id));
    expect(row!.status).toBe('completed');
    expect(row!.completedAt).not.toBeNull();
    expect(row!.signedFileUrl).toBe(`signatures/${seed.firmId}/${id}/signed.pdf`);
    expect(storage.objects.has(row!.signedFileUrl!)).toBe(true);
  });

  it('stores the signed PDF and the audit certificate as separate artifacts', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient(), storage);
    const { id } = await preparedRequest(app);
    await request(app).post(`/api/staff/signatures/${id}/send`);

    // Real PDFs this time: a 2-page signed doc + a 1-page certificate,
    // served by URL so the reconcile can fetch each part.
    const signedDoc = await PDFDocument.create();
    signedDoc.addPage([612, 792]);
    signedDoc.addPage([612, 792]);
    const signedPdf = Buffer.from(await signedDoc.save());
    const certPdf = await onePagePdf();

    const client = mockClient({
      doc: () => ({
        objectId: 'doc_sent_1',
        IsCompleted: true,
        SignedUrl: 'http://os/files/signed.pdf',
        CertificateUrl: 'http://os/files/cert.pdf',
      }),
    });
    client.fetchPdfUrl = async (url: string) => ({
      body: url.includes('cert') ? certPdf : signedPdf,
      contentType: 'application/pdf',
    });

    const done = await reconcileSignatureRequestByDocument(
      { db: harness.db, storage, client },
      'doc_sent_1',
    );
    expect(done.kind).toBe('updated');

    const [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    expect(row!.status).toBe('completed');
    // Two stored artifacts — the signed return and a separate audit
    // certificate (downloadable + filed with the return).
    expect(row!.signedFileUrl).toBeTruthy();
    expect(row!.certificateFileUrl).toBeTruthy();
    const signed = await PDFDocument.load(storage.objects.get(row!.signedFileUrl!)!);
    expect(signed.getPageCount()).toBe(2);
    const cert = await PDFDocument.load(storage.objects.get(row!.certificateFileUrl!)!);
    expect(cert.getPageCount()).toBe(1);
  });

  it('save-profile captures current placements as a role-keyed profile version', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient(), storage);
    const { id } = await preparedRequest(app);

    // No formType in the body and none on the request → 422; with one → v1.
    const first = await request(app)
      .post(`/api/staff/signatures/${id}/save-profile`)
      .send({ formType: 'engagement-letter-custom' });
    expect(first.status).toBe(201);
    expect(first.body.version).toBe(1);
    expect(first.body.count).toBe(1);

    const { signaturePlacementProfiles } = await import('@vibe/db/schema');
    const [profile] = await harness.db
      .select()
      .from(signaturePlacementProfiles)
      .where(eq(signaturePlacementProfiles.id, first.body.id));
    const fields = profile!.fields as Array<{ role: string; pageNumber: number; nx: number }>;
    expect(fields).toHaveLength(1);
    expect(fields[0]!.role).toBe('client');
    expect(fields[0]!.pageNumber).toBe(1);
    expect(Number(fields[0]!.nx)).toBeCloseTo(0.1);

    // Saving again bumps the version, never mutates v1.
    const second = await request(app)
      .post(`/api/staff/signatures/${id}/save-profile`)
      .send({ formType: 'engagement-letter-custom' });
    expect(second.status).toBe(201);
    expect(second.body.version).toBe(2);
  });

  it('save-profile rejects a request with no placements', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient(), storage);
    // Draft with a signer but no source/placements.
    const create = await request(app)
      .post('/api/staff/signatures')
      .send({ title: 'Empty', signers: [{ name: 'A', email: 'a@co.example', role: 'client' }] });
    const res = await request(app)
      .post(`/api/staff/signatures/${create.body.id}/save-profile`)
      .send({ formType: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no_placements');
  });

  it('sweeps a past-expiry request to expired', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient(), storage);
    const { id } = await preparedRequest(app);
    await request(app).post(`/api/staff/signatures/${id}/send`);
    // Force expiry into the past.
    await harness.db
      .update(signatureRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(signatureRequests.id, id));

    const flipped = await expireSignatureRequestIfDue(harness.db, id);
    expect(flipped).toBe(true);
    const [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    expect(row!.status).toBe('expired');
  });

  it('emails every signer their signing link on a parallel send', async () => {
    const storage = memStorage();
    const mailbox: SentMail[] = [];
    const app = buildApp(mockClient(), storage, mailbox);
    // Two parallel signers.
    const create = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: 'Engagement',
        signers: [
          { name: 'A', email: 'a@co.example' },
          { name: 'B', email: 'b@co.example' },
        ],
      });
    const id = create.body.id as string;
    const pdf = await onePagePdf();
    await request(app)
      .post(`/api/staff/signatures/${id}/source`)
      .set('Content-Type', 'application/pdf')
      .send(pdf);
    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const signerIds = (detail.body.signers as { id: string }[]).map((s) => s.id);
    await request(app)
      .put(`/api/staff/signatures/${id}/placements`)
      .send({
        placements: signerIds.map((sid) => ({
          signerId: sid,
          fieldType: 'signature',
          pageNumber: 1,
          nx: 0.1,
          ny: 0.7,
          nw: 0.3,
          nh: 0.05,
        })),
      });
    await request(app).post(`/api/staff/signatures/${id}/send`);

    expect(mailbox.map((m) => m.to).sort()).toEqual(['a@co.example', 'b@co.example']);
    // Each email carries that signer's OpenSign signing URL.
    expect(mailbox.every((m) => m.body.includes('/load/recipientSignPdf/doc_sent_1/'))).toBe(true);
  });

  // 0231 — deliver the signing link by text.
  async function twoSignerRequest(
    app: express.Express,
    signers: Array<{ name: string; email: string; phone?: string | null }>,
  ): Promise<string> {
    const create = await request(app)
      .post('/api/staff/signatures')
      .send({ title: 'Engagement', signers });
    const id = create.body.id as string;
    await request(app)
      .post(`/api/staff/signatures/${id}/source`)
      .set('Content-Type', 'application/pdf')
      .send(await onePagePdf());
    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const signerIds = (detail.body.signers as { id: string }[]).map((s) => s.id);
    await request(app)
      .put(`/api/staff/signatures/${id}/placements`)
      .send({
        placements: signerIds.map((sid) => ({
          signerId: sid,
          fieldType: 'signature',
          pageNumber: 1,
          nx: 0.1,
          ny: 0.7,
          nw: 0.3,
          nh: 0.05,
        })),
      });
    return id;
  }

  it('texts the signing link instead of emailing it when notifyChannel=SMS', async () => {
    const mailbox: SentMail[] = [];
    const texts: SentText[] = [];
    const app = buildApp(mockClient(), memStorage(), mailbox, texts);
    const id = await twoSignerRequest(app, [
      { name: 'A', email: 'a@co.example', phone: '(555) 123-4567' },
    ]);

    const res = await request(app)
      .post(`/api/staff/signatures/${id}/send`)
      .send({ notifyChannel: 'SMS' });
    expect(res.status).toBe(200);

    expect(mailbox).toHaveLength(0);
    expect(texts).toHaveLength(1);
    // Normalized to E.164 before handing to the SMS provider.
    expect(texts[0]!.to).toBe('+15551234567');
    expect(texts[0]!.body).toContain('/load/recipientSignPdf/doc_sent_1/');

    const [row] = await harness.db
      .select({ notifyChannel: signatureRequests.notifyChannel })
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    expect(row!.notifyChannel).toBe('SMS');
  });

  it('sends both when notifyChannel=BOTH, and records who had no mobile', async () => {
    const mailbox: SentMail[] = [];
    const texts: SentText[] = [];
    const app = buildApp(mockClient(), memStorage(), mailbox, texts);
    const id = await twoSignerRequest(app, [
      { name: 'A', email: 'a@co.example', phone: '555-123-4567' },
      { name: 'B', email: 'b@co.example' },
    ]);

    await request(app).post(`/api/staff/signatures/${id}/send`).send({ notifyChannel: 'BOTH' });

    expect(mailbox.map((m) => m.to).sort()).toEqual(['a@co.example', 'b@co.example']);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.to).toBe('+15551234567');

    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const notified = (detail.body.events as Array<{ event: string; detail: unknown }>).find(
      (e) => e.event === 'signers_notified',
    );
    expect(notified?.detail).toMatchObject({
      channel: 'BOTH',
      emailed: 2,
      texted: 1,
      noPhone: ['B'],
    });
  });

  it('hands off to the next sequential signer on the same channel', async () => {
    const storage = memStorage();
    const mailbox: SentMail[] = [];
    const texts: SentText[] = [];
    const app = buildApp(mockClient(), storage, mailbox, texts);
    const create = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: 'Engagement',
        sendInOrder: true,
        signers: [
          { name: 'A', email: 'a@co.example', phone: '555-111-1111' },
          { name: 'B', email: 'b@co.example', phone: '555-222-2222' },
        ],
      });
    const id = create.body.id as string;
    await request(app)
      .post(`/api/staff/signatures/${id}/source`)
      .set('Content-Type', 'application/pdf')
      .send(await onePagePdf());
    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const signerIds = (detail.body.signers as { id: string }[]).map((s) => s.id);
    await request(app)
      .put(`/api/staff/signatures/${id}/placements`)
      .send({
        placements: signerIds.map((sid) => ({
          signerId: sid,
          fieldType: 'signature',
          pageNumber: 1,
          nx: 0.1,
          ny: 0.7,
          nw: 0.3,
          nh: 0.05,
        })),
      });
    await request(app).post(`/api/staff/signatures/${id}/send`).send({ notifyChannel: 'SMS' });

    // Sequential: only the first signer was texted.
    expect(texts.map((t) => t.to)).toEqual(['+15551111111']);

    // A signs → B gets the hand-off, by text, not email.
    await reconcileSignatureRequestByDocument(
      {
        db: harness.db,
        storage,
        client: mockClient({
          doc: () => ({
            objectId: 'doc_sent_1',
            AuditTrail: [{ Activity: 'Signed', UserPtr: { Email: 'a@co.example' } }],
          }),
        }),
        notify: async (a) => {
          mailbox.push({ to: a.to, subject: a.subject, body: a.body });
        },
        notifySms: async (a) => {
          texts.push({ to: a.to, body: a.body });
        },
      },
      'doc_sent_1',
    );

    expect(texts.map((t) => t.to)).toEqual(['+15551111111', '+15552222222']);
    expect(mailbox).toHaveLength(0);
  });

  it('defaults to email when no channel is given', async () => {
    const mailbox: SentMail[] = [];
    const texts: SentText[] = [];
    const app = buildApp(mockClient(), memStorage(), mailbox, texts);
    const id = await twoSignerRequest(app, [
      { name: 'A', email: 'a@co.example', phone: '555-123-4567' },
    ]);

    await request(app).post(`/api/staff/signatures/${id}/send`);

    expect(mailbox).toHaveLength(1);
    expect(texts).toHaveLength(0);
  });

  // ---- resend one signer's link ------------------------------------
  it('resends a live signer their existing link by email or text', async () => {
    const mailbox: SentMail[] = [];
    const texts: SentText[] = [];
    const app = buildApp(mockClient(), memStorage(), mailbox, texts);
    const id = await twoSignerRequest(app, [
      { name: 'A', email: 'a@co.example', phone: '555-123-4567' },
    ]);
    await request(app).post(`/api/staff/signatures/${id}/send`);
    expect(mailbox).toHaveLength(1);

    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const signerId = (detail.body.signers as { id: string }[])[0]!.id;

    const byEmail = await request(app)
      .post(`/api/staff/signatures/${id}/signers/${signerId}/resend`)
      .send({ channel: 'EMAIL' });
    expect(byEmail.status).toBe(200);
    expect(mailbox).toHaveLength(2);
    // The SAME link — resend re-delivers, it never re-creates the document.
    expect(mailbox[1]!.body).toContain('/load/recipientSignPdf/doc_sent_1/');

    const bySms = await request(app)
      .post(`/api/staff/signatures/${id}/signers/${signerId}/resend`)
      .send({ channel: 'SMS' });
    expect(bySms.status).toBe(200);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.to).toBe('+15551234567');

    const after = await request(app).get(`/api/staff/signatures/${id}`);
    const resends = (after.body.events as Array<{ event: string; detail: unknown }>).filter(
      (e) => e.event === 'signer_resent',
    );
    expect(resends).toHaveLength(2);
    expect(resends.map((e) => (e.detail as { channel: string }).channel).sort()).toEqual([
      'EMAIL',
      'SMS',
    ]);
  });

  it('refuses a text resend when the signer has no mobile', async () => {
    const app = buildApp(mockClient(), memStorage(), [], []);
    const id = await twoSignerRequest(app, [{ name: 'A', email: 'a@co.example' }]);
    await request(app).post(`/api/staff/signatures/${id}/send`);
    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const signerId = (detail.body.signers as { id: string }[])[0]!.id;

    const res = await request(app)
      .post(`/api/staff/signatures/${id}/signers/${signerId}/resend`)
      .send({ channel: 'SMS' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no_phone');
  });

  it('refuses to resend on a draft, or to a signer who already signed', async () => {
    const app = buildApp(mockClient(), memStorage(), [], []);
    const id = await twoSignerRequest(app, [
      { name: 'A', email: 'a@co.example', phone: '555-123-4567' },
    ]);
    const draftDetail = await request(app).get(`/api/staff/signatures/${id}`);
    const signerId = (draftDetail.body.signers as { id: string }[])[0]!.id;

    const onDraft = await request(app)
      .post(`/api/staff/signatures/${id}/signers/${signerId}/resend`)
      .send({ channel: 'EMAIL' });
    expect(onDraft.status).toBe(409);
    expect(onDraft.body.error).toBe('not_live');

    await request(app).post(`/api/staff/signatures/${id}/send`);
    await harness.db
      .update(signatureSigners)
      .set({ status: 'signed' })
      .where(eq(signatureSigners.id, signerId));

    const signed = await request(app)
      .post(`/api/staff/signatures/${id}/signers/${signerId}/resend`)
      .send({ channel: 'EMAIL' });
    expect(signed.status).toBe(409);
    expect(signed.body.error).toBe('already_signed');
  });

  // ---- auto-file on completion -------------------------------------
  it('files the signed copy into the client folder when the request names a client', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient(), storage);
    await harness.db
      .insert(clientFolders)
      .values({ firmId: seed.firmId, clientId: seed.clientId, storagePath: 'Test Client Co' });

    // preparedRequest() links seed.clientId; no tax return involved.
    const { id } = await preparedRequest(app);
    await request(app).post(`/api/staff/signatures/${id}/send`);
    await reconcileSignatureRequestByDocument(
      {
        db: harness.db,
        storage,
        client: mockClient({
          doc: () => ({
            objectId: 'doc_sent_1',
            IsCompleted: true,
            SignedUrl: 'http://os/files/signed.pdf',
          }),
        }),
      },
      'doc_sent_1',
    );

    const filed = await harness.db
      .select({
        subfolderPath: files.subfolderPath,
        originalFilename: files.originalFilename,
        source: files.source,
      })
      .from(files)
      .where(eq(files.clientId, seed.clientId));
    const signed = filed.find((f) => f.originalFilename.includes('(signed)'));
    expect(signed).toBeTruthy();
    // Non-return requests land in Signatures, not Tax Returns (stored
    // normalized with a trailing slash).
    expect(signed!.subfolderPath).toBe('Signatures/');
    expect(signed!.source).toBe('signature');

    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const ev = (detail.body.events as Array<{ event: string; detail: unknown }>).find(
      (e) => e.event === 'signed_filed',
    );
    expect(ev?.detail).toMatchObject({ subfolder: 'Signatures' });
  });

  it('records why nothing was filed when the client folder is not bound', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient(), storage);
    const { id } = await preparedRequest(app); // no clientFolders row seeded
    await request(app).post(`/api/staff/signatures/${id}/send`);
    await reconcileSignatureRequestByDocument(
      {
        db: harness.db,
        storage,
        client: mockClient({
          doc: () => ({
            objectId: 'doc_sent_1',
            IsCompleted: true,
            SignedUrl: 'http://os/files/signed.pdf',
          }),
        }),
      },
      'doc_sent_1',
    );

    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const ev = (detail.body.events as Array<{ event: string; detail: unknown }>).find(
      (e) => e.event === 'signed_file_skipped',
    );
    expect(ev?.detail).toMatchObject({ reason: 'client_folder_not_bound' });
  });

  it('does not file anything when the request has no client', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient(), storage);
    await harness.db
      .insert(clientFolders)
      .values({ firmId: seed.firmId, clientId: seed.clientId, storagePath: 'Test Client Co' });
    const id = await twoSignerRequest(app, [{ name: 'A', email: 'a@co.example' }]);
    await request(app).post(`/api/staff/signatures/${id}/send`);
    await reconcileSignatureRequestByDocument(
      {
        db: harness.db,
        storage,
        client: mockClient({
          doc: () => ({
            objectId: 'doc_sent_1',
            IsCompleted: true,
            SignedUrl: 'http://os/files/signed.pdf',
          }),
        }),
      },
      'doc_sent_1',
    );

    const filed = await harness.db
      .select({ id: files.id })
      .from(files)
      .where(eq(files.clientId, seed.clientId));
    expect(filed).toHaveLength(0);
  });

  it('voids a sent request (terminal; reconcile then ignores it)', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient(), storage);
    const { id } = await preparedRequest(app);
    await request(app).post(`/api/staff/signatures/${id}/send`);

    const v = await request(app).post(`/api/staff/signatures/${id}/void`);
    expect(v.status).toBe(200);
    let [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    expect(row!.status).toBe('voided');

    // A late completion webhook/poll is a no-op on a terminal request.
    const out = await reconcileSignatureRequestByDocument(
      {
        db: harness.db,
        storage,
        client: mockClient({ doc: () => ({ objectId: 'doc_sent_1', IsCompleted: true }) }),
      },
      'doc_sent_1',
    );
    expect(out.kind).toBe('ignored');
    [row] = await harness.db.select().from(signatureRequests).where(eq(signatureRequests.id, id));
    expect(row!.status).toBe('voided');

    // Voiding an already-terminal request is rejected.
    const again = await request(app).post(`/api/staff/signatures/${id}/void`);
    expect(again.status).toBe(409);
  });

  it('serves the signed PDF after completion', async () => {
    const storage = memStorage();
    const app = buildApp(mockClient(), storage);
    const { id } = await preparedRequest(app);
    await request(app).post(`/api/staff/signatures/${id}/send`);
    await reconcileSignatureRequestByDocument(
      {
        db: harness.db,
        storage,
        client: mockClient({
          doc: () => ({
            objectId: 'doc_sent_1',
            IsCompleted: true,
            SignedUrl: 'http://os/files/signed.pdf',
          }),
        }),
      },
      'doc_sent_1',
    );
    const dl = await request(app).get(`/api/staff/signatures/${id}/signed`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(dl.headers['content-disposition']).toContain('attachment');
  });
});

describe('in-person (in-office) signing', () => {
  // Build an 8879 (KBA-gated) draft with one signer + a placement.
  async function prepared8879(app: express.Express, role = 'taxpayer'): Promise<string> {
    const create = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: 'Form 8879',
        formType: '8879',
        clientId: seed.clientId,
        signers: [{ name: 'Pat Taxpayer', email: 'pat@co.example', role }],
      });
    const id = create.body.id as string;
    await request(app)
      .post(`/api/staff/signatures/${id}/source`)
      .set('Content-Type', 'application/pdf')
      .send(await onePagePdf());
    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const signerIds = (detail.body.signers as { id: string }[]).map((s) => s.id);
    await request(app)
      .put(`/api/staff/signatures/${id}/placements`)
      .send({
        placements: signerIds.map((sid) => ({
          signerId: sid,
          fieldType: 'signature',
          pageNumber: 1,
          nx: 0.1,
          ny: 0.7,
          nw: 0.3,
          nh: 0.05,
        })),
      });
    return id;
  }

  it('in-person engagement letter: no email, signing_mode in_person, exposes signingUrl', async () => {
    const mailbox: SentMail[] = [];
    const app = buildApp(mockClient(), memStorage(), mailbox);
    const { id } = await preparedRequest(app);

    const send = await request(app)
      .post(`/api/staff/signatures/${id}/send`)
      .send({ inPerson: true });
    expect(send.status).toBe(200);
    expect(mailbox).toHaveLength(0); // in-person sends no email

    const [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    expect(row!.signingMode).toBe('in_person');

    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    expect(detail.body.signers[0].signingUrl).toContain('/load/recipientSignPdf/doc_sent_1/');
  });

  it('8879 in-person without attestation → identity_required; remote → kba_required', async () => {
    const app = buildApp(mockClient(), memStorage());
    const remoteId = await prepared8879(app);
    const remote = await request(app).post(`/api/staff/signatures/${remoteId}/send`);
    expect(remote.status).toBe(409);
    expect(remote.body.error).toBe('kba_required');

    const inPersonId = await prepared8879(app);
    const noAttest = await request(app)
      .post(`/api/staff/signatures/${inPersonId}/send`)
      .send({ inPerson: true });
    expect(noAttest.status).toBe(400);
    expect(noAttest.body.error).toBe('identity_required');
  });

  it('8879 in-person WITH attestation → sent, KBA bypassed, identity_verified recorded', async () => {
    const app = buildApp(mockClient(), memStorage());
    const id = await prepared8879(app);
    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const signerId = detail.body.signers[0].id as string;

    const send = await request(app)
      .post(`/api/staff/signatures/${id}/send`)
      .send({ inPerson: true, identityVerifications: [{ signerId, idType: "Driver's license" }] });
    expect(send.status).toBe(200);

    const events = await request(app).get(`/api/staff/signatures/${id}`);
    const hasAttestation = (events.body.events as { event: string }[]).some(
      (e) => e.event === 'identity_verified',
    );
    expect(hasAttestation).toBe(true);
  });
});
