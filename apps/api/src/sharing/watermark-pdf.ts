// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0102 — recipient watermark for shared PDFs. Stamps a light diagonal
// label (recipient name/org + view timestamp) on every page at download
// time. PDF-only; callers stream the result. Uses pdf-lib (pure JS), not
// Puppeteer — we're stamping an existing PDF, not rendering HTML.

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

export async function watermarkPdf(bytes: Buffer | Uint8Array, text: string): Promise<Buffer> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(10, Math.min(width, height) / 30);
    const textWidth = font.widthOfTextAtSize(text, size);
    // Center the rotated label roughly on the page.
    page.drawText(text, {
      x: Math.max(8, width / 2 - textWidth / 2.4),
      y: height / 2 - size,
      size,
      font,
      color: rgb(0.55, 0.55, 0.6),
      opacity: 0.22,
      rotate: degrees(35),
    });
  }
  const out = await pdf.save();
  return Buffer.from(out);
}

/** Build the watermark label from recipient identity. */
export function recipientWatermarkText(args: {
  recipientName?: string | null;
  organization?: string | null;
  at?: Date;
}): string {
  const parts = [args.recipientName?.trim(), args.organization?.trim()].filter((s): s is string =>
    Boolean(s && s.length),
  );
  const who = parts.join(' · ') || 'Confidential';
  return `${who} · viewed ${(args.at ?? new Date()).toISOString().slice(0, 10)}`;
}
