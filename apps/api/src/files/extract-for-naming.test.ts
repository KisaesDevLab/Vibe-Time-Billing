// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { NAMING_MAX_BYTES, extractForNaming, namingStrategyFor } from './extract-for-naming';

async function textPdf(words: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const line = 'Form W-2 Wage and Tax Statement 2024 Acme Corp ';
  let y = 750;
  for (let i = 0; i < words / 8; i++) {
    page.drawText(line, { x: 40, y, size: 10, font });
    y -= 14;
    if (y < 40) break;
  }
  return Buffer.from(await doc.save());
}

async function blankPdf(pages = 3): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

describe('namingStrategyFor', () => {
  it('routes by mime + size', () => {
    expect(namingStrategyFor('application/pdf', 1000)).toBe('pdf_text');
    expect(namingStrategyFor('image/jpeg', 1000)).toBe('image');
    expect(namingStrategyFor('application/vnd.ms-excel', 1000)).toBe('metadata');
    expect(namingStrategyFor('image/png', NAMING_MAX_BYTES + 1)).toBe('metadata');
  });
});

describe('extractForNaming', () => {
  it('extracts text from a text PDF', async () => {
    const r = await extractForNaming(await textPdf(400), 'application/pdf');
    expect(r.strategy).toBe('pdf_text');
    expect(r.text).toContain('W-2');
    expect(r.images).toHaveLength(0);
    expect(r.pages).toBe(1);
  });

  it('rasterises a PDF with no text layer (≤2 pages, JPEG, bounded size)', async () => {
    const r = await extractForNaming(await blankPdf(3), 'application/pdf');
    expect(r.strategy).toBe('pdf_raster');
    expect(r.images).toHaveLength(2);
    for (const img of r.images) {
      expect(img.mimeType).toBe('image/jpeg');
      expect(img.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    }
  }, 30_000);

  it('passes images straight through', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const r = await extractForNaming(png, 'image/png');
    expect(r.strategy).toBe('image');
    expect(r.images[0]!.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('falls back to metadata for other types and oversize bodies', async () => {
    expect((await extractForNaming(Buffer.from('hello'), 'text/plain')).strategy).toBe('metadata');
    const big = Buffer.alloc(NAMING_MAX_BYTES + 1);
    expect((await extractForNaming(big, 'image/png')).strategy).toBe('metadata');
  });

  it('treats a corrupt PDF as metadata-only', async () => {
    const r = await extractForNaming(Buffer.from('%PDF-1.4 garbage'), 'application/pdf');
    expect(r.strategy).toBe('metadata');
  });
});
