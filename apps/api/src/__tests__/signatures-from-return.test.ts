// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Create-from-return: merge selected return pages + a default-doc template
// into ONE draft signature package with auto-placed role-tagged fields,
// linked back to the tax return. Single vs MFJ placement is covered by the
// pure assemblePackagePlan test; here we verify the end-to-end wiring
// (merge, geometry, manifest, signers, placements, formType, link).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';

import {
  clientFolders,
  files,
  signatureDocumentTemplates,
  signatureFieldPlacements,
  signaturePlacementProfiles,
  signatureRequests,
  signatureSigners,
  taxReturns,
} from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  createSignaturePackageFromReturn,
  detectSignaturePagesForReturn,
} from '../tax-returns/signature-package';

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
      if (!buf) throw new Error(`not_found:${key}`);
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

async function pdfOf(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('createSignaturePackageFromReturn', () => {
  it('merges a 1040 return page + a template into one MFJ draft linked to the return', async () => {
    const storage = memStorage();

    // Client folder + a 3-page source PDF filed as the return's source.
    const [folder] = await harness.db
      .insert(clientFolders)
      .values({ firmId: seed.firmId, clientId: seed.clientId, storagePath: 'Test Client Co' })
      .returning({ id: clientFolders.id });
    const sourceKey = 'Test Client Co/return.pdf';
    storage.objects.set(sourceKey, await pdfOf(3));
    const [srcFile] = await harness.db
      .insert(files)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        clientFolderId: folder!.id,
        originalFilename: 'return.pdf',
        storageKey: sourceKey,
        sizeBytes: 1,
      })
      .returning({ id: files.id });
    const [ret] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 2024,
        formCode: '1040',
        title: 'Smith 2024 1040',
        sourceFileId: srcFile!.id,
        totalPages: 3,
      })
      .returning({ id: taxReturns.id });

    // A 1-page default-document template (no saved fields → generic layout).
    const tmplKey = `signature-templates/${seed.firmId}/consent.pdf`;
    storage.objects.set(tmplKey, await pdfOf(1));
    const [tmpl] = await harness.db
      .insert(signatureDocumentTemplates)
      .values({
        firmId: seed.firmId,
        formType: '*',
        name: '7216 Consent',
        storageKey: tmplKey,
        totalPages: 1,
      })
      .returning({ id: signatureDocumentTemplates.id });

    const result = await createSignaturePackageFromReturn(harness.db, storage, {
      firmId: seed.firmId,
      returnId: ret!.id,
      actorId: seed.appUserId,
      signers: [
        { name: 'Pat Smith', email: 'pat@s.example', role: 'taxpayer' },
        { name: 'Sam Smith', email: 'sam@s.example', role: 'spouse' },
      ],
      returnPages: [{ page: 1, layoutKey: 'us-8879' }],
      templateIds: [tmpl!.id],
      adHocKeys: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [req] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, result.requestId));
    expect(req!.status).toBe('draft');
    expect(req!.taxReturnId).toBe(ret!.id);
    expect(req!.formType).toBe('8879'); // 1040 → KBA-gated 8879
    expect(req!.sourceFileKey).toBe(`signatures/${seed.firmId}/${result.requestId}/source.pdf`);
    // merged PDF = 1 return page + 1 template page = 2 pages
    expect((req!.pageGeometry as unknown[]).length).toBe(2);
    expect((req!.packageManifest as unknown[]).length).toBe(2);
    // the merged source was actually written to storage
    expect(storage.objects.has(req!.sourceFileKey!)).toBe(true);

    const signers = await harness.db
      .select()
      .from(signatureSigners)
      .where(eq(signatureSigners.requestId, result.requestId));
    expect(signers.map((s) => s.role).sort()).toEqual(['spouse', 'taxpayer']);

    const placements = await harness.db
      .select()
      .from(signatureFieldPlacements)
      .where(eq(signatureFieldPlacements.requestId, result.requestId));
    // page 1 (return, us-8879): taxpayer sig+date + spouse sig+date = 4
    expect(placements.filter((p) => p.pageNumber === 1)).toHaveLength(4);
    // page 2 (template, generic): taxpayer + spouse = 4
    expect(placements.filter((p) => p.pageNumber === 2)).toHaveLength(4);
  });

  it('a return page whose rule references a placement profile uses its fields', async () => {
    const storage = memStorage();
    const [folder] = await harness.db
      .insert(clientFolders)
      .values({ firmId: seed.firmId, clientId: seed.clientId, storagePath: 'Test Client Co' })
      .returning({ id: clientFolders.id });
    const sourceKey = 'Test Client Co/return2.pdf';
    storage.objects.set(sourceKey, await pdfOf(2));
    const [srcFile] = await harness.db
      .insert(files)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        clientFolderId: folder!.id,
        originalFilename: 'return2.pdf',
        storageKey: sourceKey,
        sizeBytes: 1,
      })
      .returning({ id: files.id });
    const [ret] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 2024,
        formCode: '1040',
        title: 'Jones 2024 1040',
        sourceFileId: srcFile!.id,
        totalPages: 2,
      })
      .returning({ id: taxReturns.id });

    // A calibrated firm profile with a distinctive coordinate. Only the
    // taxpayer role — the spouse must get nothing from this profile.
    await harness.db.insert(signaturePlacementProfiles).values({
      firmId: seed.firmId,
      formType: 'my-8879',
      version: 1,
      fields: [
        {
          role: 'taxpayer',
          fieldType: 'signature',
          pageNumber: 1,
          nx: 0.123,
          ny: 0.456,
          nw: 0.3,
          nh: 0.04,
        },
      ],
    });

    const result = await createSignaturePackageFromReturn(harness.db, storage, {
      firmId: seed.firmId,
      returnId: ret!.id,
      actorId: seed.appUserId,
      signers: [
        { name: 'Pat Jones', email: 'pat@j.example', role: 'taxpayer' },
        { name: 'Sam Jones', email: 'sam@j.example', role: 'spouse' },
      ],
      returnPages: [{ page: 1, layoutKey: 'us-8879', profileFormType: 'my-8879' }],
      templateIds: [],
      adHocKeys: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const placements = await harness.db
      .select()
      .from(signatureFieldPlacements)
      .where(eq(signatureFieldPlacements.requestId, result.requestId));
    // Profile fields (1 taxpayer field), NOT the us-8879 built-in (4 fields).
    expect(placements).toHaveLength(1);
    expect(Number(placements[0]!.nx)).toBeCloseTo(0.123);
    expect(Number(placements[0]!.ny)).toBeCloseTo(0.456);
  });

  it('an unknown profileFormType falls back to the built-in layoutKey', async () => {
    const storage = memStorage();
    const [folder] = await harness.db
      .insert(clientFolders)
      .values({ firmId: seed.firmId, clientId: seed.clientId, storagePath: 'Test Client Co' })
      .returning({ id: clientFolders.id });
    const sourceKey = 'Test Client Co/return3.pdf';
    storage.objects.set(sourceKey, await pdfOf(1));
    const [srcFile] = await harness.db
      .insert(files)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        clientFolderId: folder!.id,
        originalFilename: 'return3.pdf',
        storageKey: sourceKey,
        sizeBytes: 1,
      })
      .returning({ id: files.id });
    const [ret] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 2024,
        formCode: '1040',
        title: 'Lee 2024 1040',
        sourceFileId: srcFile!.id,
        totalPages: 1,
      })
      .returning({ id: taxReturns.id });

    const result = await createSignaturePackageFromReturn(harness.db, storage, {
      firmId: seed.firmId,
      returnId: ret!.id,
      actorId: seed.appUserId,
      signers: [{ name: 'Kim Lee', email: 'kim@l.example', role: 'taxpayer' }],
      returnPages: [{ page: 1, layoutKey: 'us-8879', profileFormType: 'deleted-profile' }],
      templateIds: [],
      adHocKeys: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const placements = await harness.db
      .select()
      .from(signatureFieldPlacements)
      .where(eq(signatureFieldPlacements.requestId, result.requestId));
    // us-8879 built-in: taxpayer sig+date (spouse role unmatched) = 2.
    expect(placements).toHaveLength(2);
  });

  it('rejects an empty package (no pages, no docs)', async () => {
    const storage = memStorage();
    const [ret] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 2024,
        formCode: '1040',
        title: 'Empty',
      })
      .returning({ id: taxReturns.id });
    const result = await createSignaturePackageFromReturn(harness.db, storage, {
      firmId: seed.firmId,
      returnId: ret!.id,
      actorId: seed.appUserId,
      signers: [{ name: 'Pat', email: 'pat@s.example', role: 'taxpayer' }],
      returnPages: [],
      templateIds: [],
      adHocKeys: [],
    });
    expect(result).toEqual({ ok: false, code: 'empty_package' });
  });

  // Regression: storage hands back a Node Buffer, and pdfjs 4.x rejects a
  // Buffer ("provide Uint8Array, rather than Buffer"). The detect path used
  // to swallow that into noSource=true and silently surface nothing. The
  // parse must succeed and parseFailed must stay false.
  it('detects from a Buffer-backed source PDF without a parse failure', async () => {
    const storage = memStorage();
    const [folder] = await harness.db
      .insert(clientFolders)
      .values({ firmId: seed.firmId, clientId: seed.clientId, storagePath: 'Test Client Co' })
      .returning({ id: clientFolders.id });
    const sourceKey = 'Test Client Co/return.pdf';
    storage.objects.set(sourceKey, await pdfOf(2)); // memStorage.get yields a Buffer stream
    const [srcFile] = await harness.db
      .insert(files)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        clientFolderId: folder!.id,
        originalFilename: 'return.pdf',
        storageKey: sourceKey,
        sizeBytes: 1,
      })
      .returning({ id: files.id });
    const [ret] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 2024,
        formCode: '1040',
        title: 'Smith 2024 1040',
        sourceFileId: srcFile!.id,
        totalPages: 2,
      })
      .returning({ id: taxReturns.id });

    const detect = await detectSignaturePagesForReturn(harness.db, storage, seed.firmId, ret!.id);
    expect(detect).not.toBeNull();
    // The bug manifested as a swallowed parse error → no source / no bookmarks.
    expect(detect!.parseFailed).toBe(false);
    expect(detect!.noSource).toBe(false);
    expect(detect!.allBookmarks.length).toBeGreaterThan(0);
  });
});
