// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0223 — what the naming model gets to see. By MIME type:
//   application/pdf  → text of pages 1–3 (capped); if that is thin (scan)
//                      → JPEG renders of pages 1–2 as image attachments
//   image/*          → the image itself (size-capped)
//   anything else    → metadata only (filename, client, context)
//
// pdfjs in Node renders through @napi-rs/canvas automatically (its default
// NodeCanvasFactory requires it) — the package is already an api dep for
// branding icons. Any rasterisation failure degrades to metadata-only
// rather than failing the rename.

import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { AiAttachment } from '@vibe/core/ai';
import type { PDFDocumentProxy, getDocument as GetDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { logger } from '../logger';

export type ExtractStrategy = 'pdf_text' | 'pdf_raster' | 'image' | 'metadata';

export interface ExtractResult {
  text?: string;
  images: AiAttachment[];
  strategy: ExtractStrategy;
  pages?: number;
}

export const NAMING_MAX_BYTES = 8 * 1024 * 1024;
export const NAMING_TEXT_CAP = 6000;
export const NAMING_MIN_TEXT = 200;
export const NAMING_TEXT_PAGES = 3;
export const NAMING_RASTER_PAGES = 2;
export const NAMING_MAX_DIM = 1600;
/** Total attachment bytes (base64 inflates ~4/3; compared on raw bytes). */
export const NAMING_MAX_ATTACH_BYTES = 6 * 1024 * 1024;

export const NAMING_IMAGE_MIMES = new Set<AiAttachment['mimeType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

// Phone photos: converted to JPEG (heic-convert, WASM libheif) before the
// vision pass — providers don't accept HEIC directly.
export const HEIC_MIMES = new Set(['image/heic', 'image/heif', 'image/heic-sequence']);

/** HEIC/HEIF sniff: ISO-BMFF ftyp box with an heic-family brand. */
export function looksLikeHeic(body: Buffer, mimeType: string | null | undefined): boolean {
  if (HEIC_MIMES.has((mimeType ?? '').toLowerCase())) return true;
  if (body.byteLength < 12) return false;
  if (body.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = body.toString('ascii', 8, 12).toLowerCase();
  return ['heic', 'heix', 'heif', 'hevc', 'mif1', 'msf1'].includes(brand);
}

export function namingStrategyFor(
  mimeType: string | null | undefined,
  sizeBytes: number | null | undefined,
): ExtractStrategy | 'skip' {
  const mime = (mimeType ?? '').toLowerCase();
  if (sizeBytes != null && sizeBytes > NAMING_MAX_BYTES) {
    // Too big to read; still name it from metadata.
    return 'metadata';
  }
  if (mime === 'application/pdf') return 'pdf_text';
  if (NAMING_IMAGE_MIMES.has(mime as AiAttachment['mimeType']) || HEIC_MIMES.has(mime)) {
    return 'image';
  }
  return 'metadata';
}

/** pdfjs wants a URL/dir for its bundled standard fonts when rendering. */
function standardFontDataUrl(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve('pdfjs-dist/package.json');
    return path.join(path.dirname(pkg), 'standard_fonts') + path.sep;
  } catch {
    return undefined;
  }
}

function toUint8(body: Buffer | Uint8Array): Uint8Array {
  return Buffer.isBuffer(body)
    ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    : body;
}

// heic-convert's WASM decode + JS JPEG encode run synchronously and take
// seconds for a multi-MP phone photo — enough to stall every request in
// this process. An ephemeral worker thread keeps the event loop free; the
// spawn cost (~ms) is noise next to the conversion itself. The worker
// resolves heic-convert relative to THIS module's URL (passed as
// workerData) so it works from both tsx (src/) and compiled (dist/) runs.
const HEIC_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const req = createRequire(workerData.baseUrl);
const convert = req('heic-convert');
convert({ buffer: workerData.buf, format: 'JPEG', quality: workerData.quality })
  .then((out) => parentPort.postMessage({ ok: true, out }))
  .catch((err) => parentPort.postMessage({ ok: false, message: String((err && err.message) || err) }));
`;

const HEIC_CONVERT_TIMEOUT_MS = 60_000;

export function convertHeicOffThread(body: Buffer, quality = 0.8): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(HEIC_WORKER_SRC, {
      eval: true,
      workerData: { buf: toUint8(body), quality, baseUrl: import.meta.url },
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('heic conversion timed out'))),
      HEIC_CONVERT_TIMEOUT_MS,
    );
    worker.once('message', (msg: { ok: boolean; out?: Uint8Array; message?: string }) => {
      finish(() =>
        msg.ok && msg.out
          ? resolve(Buffer.from(msg.out))
          : reject(new Error(msg.message ?? 'heic conversion failed')),
      );
    });
    worker.once('error', (err) => finish(() => reject(err)));
  });
}

export async function extractForNaming(
  body: Buffer,
  mimeType: string | null | undefined,
  opts: { textPages?: number; rasterPages?: number; maxDim?: number } = {},
): Promise<ExtractResult> {
  let mime = (mimeType ?? '').toLowerCase();

  if (body.byteLength > NAMING_MAX_BYTES) return { images: [], strategy: 'metadata' };

  // HEIC/HEIF (iPhone photos) → JPEG so the vision provider can read it.
  if (looksLikeHeic(body, mime)) {
    try {
      const converted = await convertHeicOffThread(body);
      if (converted.byteLength > NAMING_MAX_ATTACH_BYTES) {
        return { images: [], strategy: 'metadata' };
      }
      body = converted;
      mime = 'image/jpeg';
    } catch (err) {
      logger.warn({ err }, 'extract-for-naming: heic conversion failed');
      return { images: [], strategy: 'metadata' };
    }
  }

  if (NAMING_IMAGE_MIMES.has(mime as AiAttachment['mimeType'])) {
    return {
      images: [
        {
          kind: 'image',
          mimeType: mime as AiAttachment['mimeType'],
          dataUrl: `data:${mime};base64,${body.toString('base64')}`,
        },
      ],
      strategy: 'image',
    };
  }

  if (mime !== 'application/pdf') return { images: [], strategy: 'metadata' };

  const textPages = opts.textPages ?? NAMING_TEXT_PAGES;
  const rasterPages = opts.rasterPages ?? NAMING_RASTER_PAGES;
  const maxDim = opts.maxDim ?? NAMING_MAX_DIM;

  let getDocument: typeof GetDocument;
  try {
    ({ getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'));
  } catch (err) {
    logger.warn({ err }, 'extract-for-naming: pdfjs unavailable');
    return { images: [], strategy: 'metadata' };
  }

  let doc: PDFDocumentProxy;
  try {
    doc = await getDocument({
      data: toUint8(body),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl: standardFontDataUrl(),
    }).promise;
  } catch (err) {
    logger.warn({ err }, 'extract-for-naming: pdf open failed');
    return { images: [], strategy: 'metadata' };
  }

  try {
    const pages = doc.numPages;
    const chunks: string[] = [];
    let total = 0;
    for (let p = 1; p <= Math.min(pages, textPages) && total < NAMING_TEXT_CAP; p++) {
      try {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        const t = tc.items
          .map((it) => it.str ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (t) {
          chunks.push(t);
          total += t.length;
        }
      } catch {
        /* skip unreadable page */
      }
    }
    const text = chunks.join('\n').slice(0, NAMING_TEXT_CAP);
    if (text.length >= NAMING_MIN_TEXT) {
      return { text, images: [], strategy: 'pdf_text', pages };
    }

    // Scan / image-only PDF: render the first pages.
    const images: AiAttachment[] = [];
    let attachBytes = 0;
    for (let p = 1; p <= Math.min(pages, rasterPages); p++) {
      try {
        const page = await doc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(1.5, maxDim / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const { createCanvas } = await import('@napi-rs/canvas');
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const jpeg = canvas.toBuffer('image/jpeg', 80);
        if (attachBytes + jpeg.byteLength > NAMING_MAX_ATTACH_BYTES) break;
        attachBytes += jpeg.byteLength;
        images.push({
          kind: 'image',
          mimeType: 'image/jpeg',
          dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        });
      } catch (err) {
        logger.warn({ err, page: p }, 'extract-for-naming: raster failed');
        break;
      }
    }
    if (images.length > 0) {
      return { ...(text ? { text } : {}), images, strategy: 'pdf_raster', pages };
    }
    return { ...(text ? { text } : {}), images: [], strategy: 'metadata', pages };
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}
