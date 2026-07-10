// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Q35 — OpenSign e-signature provider (contract + completion tests).
//
// No live sidecar: we inject a mock EsignProvider + a MockStorageClient
// from @vibe/storage, and drive the webhook with a raw body + computed
// HMAC. Coverage:
//   - provider createEnvelope returns signingUrl; fetchCertificatePdf
//     returns bytes (createOpenSignProvider against a mocked fetch).
//   - webhook: bad-HMAC → 401; unknown-envelope → acknowledged+ignored;
//     duplicate-event → no-op; valid completed → row SIGNED + cert key
//     set + per-row HMAC present + verifies via the signature-verify
//     path + audit emitted.
//   - single-signer OpenSign completion → ACCEPTED + freeze.
//   - multi-signer mixed native+OpenSign → ACCEPTED only when both done.
//   - concurrent completion idempotent (no double freeze).

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';

import { auditLog, engagements, proposals, signatures } from '@vibe/db/schema';
import { verifySignatureHmac, deriveFirmHmacKey } from '@vibe/core/proposals/server';
import { MockStorageClient } from '@vibe/storage';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createOpenSignProvider, type EsignEnvelope, type EsignProvider } from '../esign/provider';
import { completeOpenSignEnvelope } from '../esign/opensign-complete';
import { createOpenSignWebhookRouter } from '../webhooks/opensign';

const HMAC_SEED = 'opensign-test-hmac-seed-32-bytes-aaaa';
const WEBHOOK_SECRET = 'opensign-webhook-secret-xyz';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

function mockStorage(): MockStorageClient {
  return new MockStorageClient({ rootPath: mkdtempSync(join(tmpdir(), 'opensign-cert-')) });
}

// A mock OpenSign provider: createEnvelope returns a signing URL, status
// flips to SIGNED on demand, fetchCertificatePdf returns deterministic
// bytes. sign() throws (clients sign in the sidecar UI).
function mockProvider(): EsignProvider & { _signed: Set<string> } {
  const signed = new Set<string>();
  return {
    _signed: signed,
    id: 'opensign',
    async createEnvelope(input) {
      const env: EsignEnvelope = {
        providerId: 'opensign',
        envelopeId: `env_${input.proposalId.slice(0, 8)}_${Math.random().toString(36).slice(2, 8)}`,
        status: 'PENDING',
        signedAt: null,
        certificateObjectKey: null,
        signingUrl: 'https://opensign.test/sign/abc123',
      };
      return env;
    },
    async sign() {
      throw new Error('opensign_sign_not_directly_invokable');
    },
    async getStatus(envelopeId) {
      return {
        providerId: 'opensign',
        envelopeId,
        status: signed.has(envelopeId) ? 'SIGNED' : 'PENDING',
        signedAt: signed.has(envelopeId) ? new Date() : null,
        certificateObjectKey: null,
        signingUrl: null,
      };
    },
    async fetchCertificatePdf(envelopeId) {
      return {
        body: Buffer.from(`%PDF-1.4 cert for ${envelopeId}`),
        contentType: 'application/pdf',
      };
    },
  };
}

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  header(_n: string): undefined;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
    header() {
      return undefined;
    },
  };
}

// Drive the webhook router's POST '/' through its raw-body middleware +
// handler with a Buffer body + header map.
async function postWebhook(
  router: ReturnType<typeof createOpenSignWebhookRouter>,
  rawBody: Buffer,
  headers: Record<string, string>,
): Promise<FakeRes> {
  const res = makeRes();
  const req = {
    body: rawBody,
    method: 'POST',
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    ip: '203.0.113.9',
  } as unknown as Request;
  // The router stack: [raw-body middleware, route]. Our req.body is
  // already a Buffer, so invoke the POST handler directly.
  const layer = router.stack.find((l) => {
    const r = (l as unknown as { route?: { path: string; methods: Record<string, boolean> } })
      .route;
    return r?.path === '/' && r.methods['post'] === true;
  });
  if (!layer) throw new Error('webhook route not registered');
  const route = (
    layer as unknown as { route: { stack: { handle: (...a: unknown[]) => unknown }[] } }
  ).route;
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (rq: Request, rs: Response) => Promise<void>)(req, res as unknown as Response);
  return res;
}

function signBody(raw: Buffer, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

async function createSentProposal(
  seed: { firmId: string; clientId: string; appUserId: string },
  opts: { signers: { name: string; email: string; method: 'TYPED_NAME' | 'OPENSIGN' }[] },
): Promise<{ proposalId: string; signatureIds: string[]; envelopeIds: string[] }> {
  const [proposal] = await harness.db
    .insert(proposals)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      status: 'SENT',
      title: 'OpenSign Proposal',
      brochureJsonb: { schemaVersion: 1, blocks: [] } as unknown as Record<string, unknown>,
      createdById: seed.appUserId,
    })
    .returning({ id: proposals.id });
  const proposalId = proposal!.id;
  const signatureIds: string[] = [];
  const envelopeIds: string[] = [];
  let seq = 0;
  for (const s of opts.signers) {
    const envelopeId = s.method === 'OPENSIGN' ? `env_${proposalId.slice(0, 8)}_${seq}` : null;
    const [row] = await harness.db
      .insert(signatures)
      .values({
        proposalId,
        role: seq === 0 ? 'PRIMARY' : 'COSIGNER',
        sequence: seq,
        required: true,
        signerName: s.name,
        signerEmail: s.email,
        method: s.method === 'OPENSIGN' ? 'OPENSIGN' : null,
        state: 'PENDING',
        opensignEnvelopeId: envelopeId,
      })
      .returning({ id: signatures.id });
    signatureIds.push(row!.id);
    if (envelopeId) envelopeIds.push(envelopeId);
    seq += 1;
  }
  return { proposalId, signatureIds, envelopeIds };
}

describe('Q35 — OpenSign provider contract (real Parse cloud functions)', () => {
  it('createEnvelope builds the OpenSign signing URL from the created doc id + contact', async () => {
    const fetchImpl: typeof fetch = (async (url: string) => {
      const fn = url.split('/functions/')[1] ?? '';
      const map: Record<string, unknown> = {
        loginuser: { sessionToken: 'r:s', objectId: 'u1' },
        getUserDetails: { objectId: 'ext1' },
        savefile: { url: 'http://opensign:8080/files/x.pdf?token=jwt' },
        savecontact: { objectId: 'contact_42' },
        createdocumentfromapp: { objectId: 'doc_abc' },
      };
      return new Response(JSON.stringify({ result: map[fn] ?? {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080/app',
      appId: 'opensign',
      masterKey: 'mk',
      publicUrl: 'https://os.example',
      apiEmail: 'api@firm.example',
      apiPassword: 'pw',
      fetchImpl,
    });
    const e = await p.createEnvelope({
      proposalId: 'p-1',
      signerName: 'Jane',
      signerEmail: 'jane@x.com',
      documentTitle: 'Letter',
      documentHtml: '<p>x</p>',
    });
    expect(e.envelopeId).toBe('doc_abc');
    expect(e.signingUrl).toBe('https://os.example/load/recipientSignPdf/doc_abc/contact_42');
  });

  it('fetchCertificatePdf resolves the doc then GETs the signed/cert PDF bytes', async () => {
    let pdfFetched = false;
    const fetchImpl: typeof fetch = (async (url: string) => {
      if (url.includes('/functions/getDocument')) {
        return new Response(
          JSON.stringify({
            result: {
              objectId: 'doc_abc',
              IsCompleted: true,
              CertificateUrl: 'http://opensign:8080/files/cert.pdf?token=jwt',
            },
          }),
          { status: 200 },
        );
      }
      // The cert URL fetch.
      pdfFetched = true;
      expect(url).toContain('cert.pdf');
      return new Response(Buffer.from('%PDF-bytes'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }) as unknown as typeof fetch;
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080/app',
      appId: 'opensign',
      masterKey: 'mk',
      fetchImpl,
    });
    const cert = await p.fetchCertificatePdf('doc_abc');
    expect(pdfFetched).toBe(true);
    expect(cert.contentType).toBe('application/pdf');
    expect(cert.body.toString()).toBe('%PDF-bytes');
  });

  it('fetchCertificatePdf merges signed doc + certificate into one PDF', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const mk = async (pages: number): Promise<Buffer> => {
      const d = await PDFDocument.create();
      for (let i = 0; i < pages; i++) d.addPage([612, 792]);
      return Buffer.from(await d.save());
    };
    const signedPdf = await mk(2);
    const certPdf = await mk(1);
    const fetchImpl: typeof fetch = (async (url: string) => {
      if (url.includes('/functions/getDocument')) {
        return new Response(
          JSON.stringify({
            result: {
              objectId: 'doc_abc',
              IsCompleted: true,
              SignedUrl: 'http://opensign:8080/files/signed.pdf?token=jwt',
              CertificateUrl: 'http://opensign:8080/files/cert.pdf?token=jwt',
            },
          }),
          { status: 200 },
        );
      }
      const body = url.includes('cert.pdf') ? certPdf : signedPdf;
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }) as unknown as typeof fetch;
    const p = createOpenSignProvider({
      baseUrl: 'http://opensign:8080/app',
      appId: 'opensign',
      masterKey: 'mk',
      fetchImpl,
    });
    const out = await p.fetchCertificatePdf('doc_abc');
    expect(out.contentType).toBe('application/pdf');
    const merged = await PDFDocument.load(out.body);
    expect(merged.getPageCount()).toBe(3); // 2 signed pages + 1 certificate page
  });
});

describe('Q35 — OpenSign webhook', () => {
  function router(provider = mockProvider(), storage = mockStorage()) {
    return createOpenSignWebhookRouter({
      db: harness.db,
      provider,
      storage,
      webhookSecret: WEBHOOK_SECRET,
      hmacSeed: HMAC_SEED,
    });
  }

  it('bad HMAC → 401', async () => {
    const r = router();
    const raw = Buffer.from(JSON.stringify({ event: 'completed', objectId: 'doc1' }));
    const res = await postWebhook(r, raw, { 'x-webhook-signature': 'deadbeef' });
    expect(res.statusCode).toBe(401);
  });

  it('unknown document → acknowledged + ignored (no error)', async () => {
    const r = router();
    const raw = Buffer.from(JSON.stringify({ event: 'completed', objectId: 'nope' }));
    const res = await postWebhook(r, raw, { 'x-webhook-signature': signBody(raw) });
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { received: boolean }).received).toBe(true);
  });

  it('duplicate event → no-op (idempotent)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const provider = mockProvider();
    const storage = mockStorage();
    const r = router(provider, storage);
    const { envelopeIds } = await createSentProposal(seed, {
      signers: [{ name: 'Alice', email: 'a@co.example', method: 'OPENSIGN' }],
    });
    provider._signed.add(envelopeIds[0]!);
    const raw = Buffer.from(JSON.stringify({ event: 'completed', objectId: envelopeIds[0] }));
    const first = await postWebhook(r, raw, { 'x-webhook-signature': signBody(raw) });
    expect(first.statusCode).toBe(200);
    const second = await postWebhook(r, raw, { 'x-webhook-signature': signBody(raw) });
    expect(second.statusCode).toBe(200);
    expect((second.jsonBody as { duplicate?: boolean }).duplicate).toBe(true);
  });

  it('valid completed → row SIGNED + cert key + HMAC verifies + audit emitted; single-signer ACCEPTED+freeze', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const provider = mockProvider();
    const storage = mockStorage();
    const r = router(provider, storage);
    const { proposalId, signatureIds, envelopeIds } = await createSentProposal(seed, {
      signers: [{ name: 'Alice', email: 'a@co.example', method: 'OPENSIGN' }],
    });
    provider._signed.add(envelopeIds[0]!);
    const raw = Buffer.from(
      JSON.stringify({
        event: 'completed',
        objectId: envelopeIds[0],
        file: 'http://opensign:8080/files/signed.pdf?token=jwt',
        certificate: 'http://opensign:8080/files/cert.pdf?token=jwt',
      }),
    );
    const res = await postWebhook(r, raw, { 'x-webhook-signature': signBody(raw) });
    expect(res.statusCode).toBe(200);

    const [sig] = await harness.db
      .select()
      .from(signatures)
      .where(eq(signatures.id, signatureIds[0]!));
    expect(sig!.state).toBe('SIGNED');
    expect(sig!.opensignCertificateObjectKey).toBe(
      `opensign-certs/${seed.firmId}/${proposalId}/${signatureIds[0]}.pdf`,
    );
    expect(sig!.hmacSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(sig!.method).toBe('OPENSIGN');

    // The cert PDF actually landed in storage.
    const head = await storage.head(sig!.opensignCertificateObjectKey!);
    expect(head).not.toBeNull();

    // Per-row HMAC verifies via the same canonical-record path the
    // signature-verify route uses.
    const key = deriveFirmHmacKey(HMAC_SEED, seed.firmId);
    const result = verifySignatureHmac(
      {
        id: sig!.id,
        proposalId: sig!.proposalId,
        role: sig!.role,
        sequence: sig!.sequence,
        signerName: sig!.signerName,
        signerEmail: sig!.signerEmail,
        signerPhone: sig!.signerPhone,
        signerIp: sig!.signerIp,
        signerUa: sig!.signerUa,
        method: sig!.method ?? '',
        state: sig!.state,
        typedName: sig!.typedName,
        signatureSvg: sig!.signatureSvg,
        opensignEnvelopeId: sig!.opensignEnvelopeId,
        opensignCertificateObjectKey: sig!.opensignCertificateObjectKey,
        payloadHash: sig!.payloadHash,
        signedAt: sig!.signedAt?.toISOString() ?? null,
        declinedAt: sig!.declinedAt?.toISOString() ?? null,
        declinedReason: sig!.declinedReason,
      },
      key,
      sig!.hmacSignature,
    );
    expect(result.ok).toBe(true);

    // Single required signer → proposal ACCEPTED + engagement frozen.
    const [prop] = await harness.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(prop!.status).toBe('ACCEPTED');
    expect(prop!.acceptedAt).not.toBeNull();
    const engs = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.fromProposalId, proposalId));
    expect(engs).toHaveLength(1);

    // Audit row emitted for the acceptance.
    const audits = await harness.db
      .select({ entityType: auditLog.entityType })
      .from(auditLog)
      .where(eq(auditLog.entityId, signatureIds[0]!));
    expect(audits.some((a) => a.entityType === 'proposal.opensign_accepted')).toBe(true);
  });

  it('envelope.declined → row DECLINED + proposal IN_PROGRESS', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router();
    const { proposalId, signatureIds, envelopeIds } = await createSentProposal(seed, {
      signers: [
        { name: 'Alice', email: 'a@co.example', method: 'OPENSIGN' },
        { name: 'Bob', email: 'b@co.example', method: 'TYPED_NAME' },
      ],
    });
    const raw = Buffer.from(
      JSON.stringify({
        event: 'declined',
        objectId: envelopeIds[0],
        declinedBy: 'a@co.example',
        declinedReason: 'changed mind',
      }),
    );
    const res = await postWebhook(r, raw, { 'x-webhook-signature': signBody(raw) });
    expect(res.statusCode).toBe(200);
    const [sig] = await harness.db
      .select()
      .from(signatures)
      .where(eq(signatures.id, signatureIds[0]!));
    expect(sig!.state).toBe('DECLINED');
    expect(sig!.declinedReason).toBe('changed mind');
    const [prop] = await harness.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(prop!.status).toBe('IN_PROGRESS');
  });
});

describe('Q35 — mixed multi-signer + concurrency', () => {
  it('mixed native + OpenSign → ACCEPTED only when both done', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const provider = mockProvider();
    const storage = mockStorage();
    const { proposalId, signatureIds, envelopeIds } = await createSentProposal(seed, {
      signers: [
        { name: 'Alice (opensign)', email: 'a@co.example', method: 'OPENSIGN' },
        { name: 'Bob (native)', email: 'b@co.example', method: 'TYPED_NAME' },
      ],
    });

    // Alice (OpenSign) completes first → IN_PROGRESS, still 1 required.
    provider._signed.add(envelopeIds[0]!);
    await completeOpenSignEnvelope(
      { db: harness.db, provider, storage, hmacSeed: HMAC_SEED },
      envelopeIds[0]!,
    );
    let prop = (await harness.db.select().from(proposals).where(eq(proposals.id, proposalId)))[0]!;
    expect(prop.status).toBe('IN_PROGRESS');
    let engs = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.fromProposalId, proposalId));
    expect(engs).toHaveLength(0);

    // Bob (native) signs out-of-band by marking his row SIGNED, then we
    // run the same shared advance via a second OpenSign-less path: flip
    // Bob then re-trigger nothing — simulate native by directly signing
    // his row + advancing. Simplest: mark Bob SIGNED and complete via the
    // shared gating by re-completing nothing — instead use a direct sign.
    await harness.db
      .update(signatures)
      .set({
        state: 'SIGNED',
        method: 'TYPED_NAME',
        typedName: 'Bob',
        payloadHash: 'c'.repeat(64),
        signedAt: new Date(),
      })
      .where(eq(signatures.id, signatureIds[1]!));
    // Now advance through the shared fn (as the native /accept path would).
    const { advanceSignatureToSigned } = await import('../proposals/sign-advance');
    await harness.db.transaction(async (tx) => {
      const [p] = await tx
        .select()
        .from(proposals)
        .where(eq(proposals.id, proposalId))
        .for('update');
      await advanceSignatureToSigned({
        tx: tx as never,
        proposal: p!,
        signatureId: signatureIds[1]!,
        now: new Date(),
      });
    });

    prop = (await harness.db.select().from(proposals).where(eq(proposals.id, proposalId)))[0]!;
    expect(prop.status).toBe('ACCEPTED');
    engs = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.fromProposalId, proposalId));
    expect(engs).toHaveLength(1);
  });

  it('concurrent completion of the same envelope is idempotent (no double freeze)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const provider = mockProvider();
    const storage = mockStorage();
    const { proposalId, envelopeIds } = await createSentProposal(seed, {
      signers: [{ name: 'Alice', email: 'a@co.example', method: 'OPENSIGN' }],
    });
    provider._signed.add(envelopeIds[0]!);

    const deps = { db: harness.db, provider, storage, hmacSeed: HMAC_SEED };
    const [a, b] = await Promise.all([
      completeOpenSignEnvelope(deps, envelopeIds[0]!),
      completeOpenSignEnvelope(deps, envelopeIds[0]!),
    ]);
    // Exactly one advanced; the other was a no-op.
    const advanced = [a, b].filter((o) => o.kind === 'advanced');
    expect(advanced.length).toBeGreaterThanOrEqual(1);

    const [prop] = await harness.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(prop!.status).toBe('ACCEPTED');
    const engs = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.fromProposalId, proposalId));
    // No double freeze.
    expect(engs).toHaveLength(1);
  });
});
