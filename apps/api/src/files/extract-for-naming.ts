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
  if (NAMING_IMAGE_MIMES.has(mime as AiAttachment['mimeType'])) return 'image';
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

export async function extractForNaming(
  body: Buffer,
  mimeType: string | null | undefined,
  opts: { textPages?: number; rasterPages?: number; maxDim?: number } = {},
): Promise<ExtractResult> {
  const mime = (mimeType ?? '').toLowerCase();

  if (body.byteLength > NAMING_MAX_BYTES) return { images: [], strategy: 'metadata' };

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
