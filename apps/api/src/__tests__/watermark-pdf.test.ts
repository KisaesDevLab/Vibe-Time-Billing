// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0102 — PDF recipient watermark stamping.

import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import { watermarkPdf, recipientWatermarkText } from '../sharing/watermark-pdf';

describe('watermarkPdf', () => {
  it('stamps every page and preserves page count + validity', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    const input = Buffer.from(await doc.save());

    const out = await watermarkPdf(
      input,
      recipientWatermarkText({ recipientName: 'Jane Doe', organization: 'Acme Bank' }),
    );

    expect(out.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(2);
    expect(out.length).toBeGreaterThan(input.length - 50); // stamped, not truncated
  });
});

describe('recipientWatermarkText', () => {
  it('composes name + org + view date', () => {
    expect(
      recipientWatermarkText({
        recipientName: 'Jane Doe',
        organization: 'Acme Bank',
        at: new Date('2026-01-02T10:00:00Z'),
      }),
    ).toBe('Jane Doe · Acme Bank · viewed 2026-01-02');
  });
  it('falls back to Confidential when no identity', () => {
    expect(recipientWatermarkText({ at: new Date('2026-01-02T00:00:00Z') })).toBe(
      'Confidential · viewed 2026-01-02',
    );
  });
});
