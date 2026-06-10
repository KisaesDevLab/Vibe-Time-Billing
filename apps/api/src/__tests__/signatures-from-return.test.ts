// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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
  signatureRequests,
  signatureSigners,
  taxReturns,
} from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createSignaturePackageFromReturn } from '../tax-returns/signature-package';

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
});
