// SPDX-License-Identifier: Elastic-2.0
//
// TR-2 renderer unit tests — the security-critical property is that the
// output PDF contains ONLY the planned pages, never the withheld ones,
// regardless of how many pages the source holds.

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import type { StorageClient } from '@vibe/storage';

import { renderScopedReturnPdf, RenderError } from '../tax-returns/render';

async function makeSourcePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 300]);
  return Buffer.from(await doc.save());
}

function storageWith(entries: Record<string, Buffer>): StorageClient {
  return {
    kind: 'mock',
    async get(key: string) {
      const bytes = entries[key];
      if (!bytes) throw new Error(`object not found: ${key}`);
      return { body: Readable.from(bytes), meta: {} };
    },
  } as unknown as StorageClient;
}

const KEY = 'Client/Tax Returns/return.pdf';

describe('renderScopedReturnPdf', () => {
  it('outputs only the planned pages (SELECTED subset)', async () => {
    const storage = storageWith({ [KEY]: await makeSourcePdf(14) });
    const out = await renderScopedReturnPdf({
      storage,
      sourceStorageKey: KEY,
      pageIndices1Based: [1, 2, 3, 4, 5, 6, 7], // s1 (1-5) + s2 (6-7)
      watermarkText: 'Client · viewed 2026-06-08',
    });
    const loaded = await PDFDocument.load(out);
    expect(loaded.getPageCount()).toBe(7);
  });

  it('renders every page for a FULL plan', async () => {
    const storage = storageWith({ [KEY]: await makeSourcePdf(14) });
    const out = await renderScopedReturnPdf({
      storage,
      sourceStorageKey: KEY,
      pageIndices1Based: Array.from({ length: 14 }, (_, i) => i + 1),
      watermarkText: 'w',
    });
    expect((await PDFDocument.load(out)).getPageCount()).toBe(14);
  });

  it('drops plan pages that fall outside the actual source', async () => {
    const storage = storageWith({ [KEY]: await makeSourcePdf(3) });
    const out = await renderScopedReturnPdf({
      storage,
      sourceStorageKey: KEY,
      pageIndices1Based: [1, 2, 5], // page 5 doesn't exist
      watermarkText: 'w',
    });
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2);
  });

  it('throws when no plan page exists in the source', async () => {
    const storage = storageWith({ [KEY]: await makeSourcePdf(3) });
    await expect(
      renderScopedReturnPdf({
        storage,
        sourceStorageKey: KEY,
        pageIndices1Based: [9, 10],
        watermarkText: 'w',
      }),
    ).rejects.toBeInstanceOf(RenderError);
  });

  it('throws source_unavailable when the object is missing', async () => {
    const storage = storageWith({});
    await expect(
      renderScopedReturnPdf({
        storage,
        sourceStorageKey: KEY,
        pageIndices1Based: [1],
        watermarkText: 'w',
      }),
    ).rejects.toMatchObject({ code: 'source_unavailable' });
  });

  it('throws on an empty plan', async () => {
    const storage = storageWith({ [KEY]: await makeSourcePdf(3) });
    await expect(
      renderScopedReturnPdf({
        storage,
        sourceStorageKey: KEY,
        pageIndices1Based: [],
        watermarkText: 'w',
      }),
    ).rejects.toMatchObject({ code: 'empty_plan' });
  });
});
