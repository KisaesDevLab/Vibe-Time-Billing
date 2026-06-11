// SPDX-License-Identifier: Elastic-2.0
//
// Phase 3 — per-page PDF geometry capture. Page dimensions in POINTS come
// from each page's MediaBox (via pdf-lib), read at upload time. Pages can
// differ in size, so this is never assumed — it's the denominator the
// normalized field coordinates map onto.

import { PDFDocument } from 'pdf-lib';

export interface PageGeometry {
  /** 1-based. */
  pageNumber: number;
  widthPt: number;
  heightPt: number;
}

/** Read every page's width/height in PDF points from the document. */
export async function capturePageGeometry(pdfBytes: Buffer | Uint8Array): Promise<PageGeometry[]> {
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  return pdf.getPages().map((page, i) => {
    const { width, height } = page.getSize();
    return { pageNumber: i + 1, widthPt: width, heightPt: height };
  });
}

/** Look up one page's geometry (throws if the page isn't in the doc). */
export function geometryForPage(geometry: PageGeometry[], pageNumber: number): PageGeometry {
  const g = geometry.find((p) => p.pageNumber === pageNumber);
  if (!g) throw new Error(`no geometry for page ${pageNumber}`);
  return g;
}
