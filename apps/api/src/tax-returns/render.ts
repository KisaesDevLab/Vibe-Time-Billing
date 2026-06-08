// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-2 renderer — turns an extraction plan into the scoped, watermarked
// PDF a client or 3rd-party recipient is entitled to. This is the piece
// that was previously stubbed (`pdf_renderer_unavailable`); the planning
// surface (@vibe/core/tax-returns planExtraction) stays pure and this
// module owns the byte work.
//
// Security invariant: the output can ONLY contain pages listed in
// `pageIndices1Based`. We build a fresh PDFDocument and copy exactly
// those pages — withheld sections never leave the server even though the
// source PDF on disk holds the full return. The per-viewer watermark is
// stamped on every output page.

import type { Readable } from 'node:stream';

import { PDFDocument } from 'pdf-lib';

import type { StorageClient } from '@vibe/storage';

import { watermarkPdf } from '../sharing/watermark-pdf';

export class RenderError extends Error {
  constructor(
    public code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'RenderError';
  }
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export interface RenderScopedReturnInput {
  storage: StorageClient;
  /** Full storage key of the source (full-return) PDF. */
  sourceStorageKey: string;
  /** Ordered, 1-based page numbers from planExtraction(). */
  pageIndices1Based: number[];
  /** Canonical watermark string from planExtraction(). */
  watermarkText: string;
}

/**
 * Render the subset PDF for one release/share. Throws RenderError on any
 * failure (missing source, unreadable PDF, empty plan) so callers can
 * map to an HTTP status — never falling back to the unscoped source.
 */
export async function renderScopedReturnPdf(input: RenderScopedReturnInput): Promise<Buffer> {
  if (input.pageIndices1Based.length === 0) {
    throw new RenderError('empty_plan', 'no pages to render');
  }

  let srcBytes: Buffer;
  try {
    const { body } = await input.storage.get(input.sourceStorageKey);
    srcBytes = await readAll(body);
  } catch (err) {
    throw new RenderError('source_unavailable', (err as Error).message);
  }

  let src: PDFDocument;
  try {
    src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  } catch (err) {
    throw new RenderError('source_unreadable', (err as Error).message);
  }

  // 1-based → 0-based; drop out-of-range pages defensively (the stored
  // totalPages can drift from the actual PDF). Order + dedup already
  // handled by planExtraction.
  const pageCount = src.getPageCount();
  const indices0 = input.pageIndices1Based.map((p) => p - 1).filter((i) => i >= 0 && i < pageCount);
  if (indices0.length === 0) {
    throw new RenderError('no_pages_in_source', 'plan pages fall outside the source document');
  }

  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indices0);
  for (const page of copied) out.addPage(page);
  const subset = Buffer.from(await out.save());

  // Stamp the per-viewer watermark on every page of the subset.
  return watermarkPdf(subset, input.watermarkText);
}
