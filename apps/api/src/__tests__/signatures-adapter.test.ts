// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 5 — the coordinate adapter is the only place normalized→OpenSign
// math lives, so it is golden-fixture tested here: single/multi page +
// signer, a non-Letter (A4) page, and byte-stable output. Plus phase 3
// geometry capture from a real multi-page mixed-size PDF.

import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import { capturePageGeometry } from '../signatures/geometry';
import { toOpenSignPlaceholder, type AdapterPlacement } from '../signatures/adapter';

const LETTER = [{ pageNumber: 1, widthPt: 612, heightPt: 792 }];

describe('capturePageGeometry (phase 3)', () => {
  it('reads per-page point dims for a mixed-size document', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]); // Letter
    pdf.addPage([595.28, 841.89]); // A4
    const bytes = await pdf.save();
    const geo = await capturePageGeometry(Buffer.from(bytes));
    expect(geo).toHaveLength(2);
    expect(geo[0]).toMatchObject({ pageNumber: 1, widthPt: 612 });
    expect(Math.round(geo[1]!.heightPt)).toBe(842);
  });
});

describe('toOpenSignPlaceholder (phase 5)', () => {
  it('maps a single signature on Letter to top-left PDF points', () => {
    const out = toOpenSignPlaceholder(
      [{ signerId: 's1', opensignContactId: 'C1', role: 'officer', color: '#0a0' }],
      [
        {
          signerId: 's1',
          fieldType: 'signature',
          pageNumber: 1,
          nx: 0.1,
          ny: 0.8,
          nw: 0.25,
          nh: 0.06,
        },
      ],
      LETTER,
    );
    expect(out).toHaveLength(1);
    const ph = out[0]!;
    expect(ph.signerObjId).toBe('C1');
    expect(ph.signerPtr).toEqual({
      __type: 'Pointer',
      className: 'contracts_Contactbook',
      objectId: 'C1',
    });
    const pos = ph.placeHolder[0]!.pos[0]!;
    expect(pos.xPosition).toBeCloseTo(0.1 * 612, 1);
    expect(pos.yPosition).toBeCloseTo(0.8 * 792, 1);
    expect(pos.Width).toBeCloseTo(0.25 * 612, 1);
    expect(pos.Height).toBeCloseTo(0.06 * 792, 1);
    expect(pos.type).toBe('signature');
    expect(pos.options.status).toBe('required');
  });

  it('groups multiple signers across multiple pages', () => {
    const geometry = [
      { pageNumber: 1, widthPt: 612, heightPt: 792 },
      { pageNumber: 2, widthPt: 612, heightPt: 792 },
    ];
    const placements: AdapterPlacement[] = [
      {
        signerId: 's1',
        fieldType: 'signature',
        pageNumber: 1,
        nx: 0.1,
        ny: 0.5,
        nw: 0.2,
        nh: 0.05,
      },
      { signerId: 's1', fieldType: 'date', pageNumber: 2, nx: 0.3, ny: 0.6, nw: 0.15, nh: 0.04 },
      { signerId: 's2', fieldType: 'initials', pageNumber: 2, nx: 0.7, ny: 0.9, nw: 0.1, nh: 0.04 },
    ];
    const out = toOpenSignPlaceholder(
      [
        { signerId: 's1', opensignContactId: 'C1', color: '#0a0' },
        { signerId: 's2', opensignContactId: 'C2', color: '#00a' },
      ],
      placements,
      geometry,
    );
    expect(out).toHaveLength(2);
    // signer 1 has fields on 2 pages
    expect(out[0]!.placeHolder.map((p) => p.pageNumber)).toEqual([1, 2]);
    // signer 2 only on page 2, with initials → mapped type
    expect(out[1]!.placeHolder).toHaveLength(1);
    expect(out[1]!.placeHolder[0]!.pos[0]!.type).toBe('initials');
    // text → 'textbox', optional status
    const opt = toOpenSignPlaceholder(
      [{ signerId: 's1', opensignContactId: 'C1', color: '#0a0' }],
      [
        {
          signerId: 's1',
          fieldType: 'text',
          pageNumber: 1,
          nx: 0.1,
          ny: 0.1,
          nw: 0.2,
          nh: 0.03,
          required: false,
        },
      ],
      LETTER,
    );
    expect(opt[0]!.placeHolder[0]!.pos[0]!.type).toBe('textbox');
    expect(opt[0]!.placeHolder[0]!.pos[0]!.options.status).toBe('optional');
  });

  it('scales correctly for a non-Letter (A4) page', () => {
    const out = toOpenSignPlaceholder(
      [{ signerId: 's1', opensignContactId: 'C1', color: '#0a0' }],
      [
        {
          signerId: 's1',
          fieldType: 'signature',
          pageNumber: 1,
          nx: 0.5,
          ny: 0.5,
          nw: 0.2,
          nh: 0.05,
        },
      ],
      [{ pageNumber: 1, widthPt: 595.28, heightPt: 841.89 }],
    );
    const pos = out[0]!.placeHolder[0]!.pos[0]!;
    expect(pos.xPosition).toBeCloseTo(0.5 * 595.28, 1);
    expect(pos.yPosition).toBeCloseTo(0.5 * 841.89, 1);
    expect(pos.Width).toBeCloseTo(0.2 * 595.28, 1);
  });

  it('produces byte-stable output (golden)', () => {
    const out = toOpenSignPlaceholder(
      [{ signerId: 's1', opensignContactId: 'C1', role: 'officer', color: '#0a0' }],
      [
        {
          signerId: 's1',
          fieldType: 'signature',
          pageNumber: 1,
          nx: 0.1,
          ny: 0.8,
          nw: 0.25,
          nh: 0.06,
        },
      ],
      LETTER,
    );
    expect(JSON.stringify(out)).toBe(
      JSON.stringify([
        {
          Id: 1,
          signerObjId: 'C1',
          signerPtr: { __type: 'Pointer', className: 'contracts_Contactbook', objectId: 'C1' },
          Role: 'officer',
          blockColor: '#0a0',
          placeHolder: [
            {
              pageNumber: 1,
              pos: [
                {
                  xPosition: 61.2,
                  yPosition: 633.6,
                  Width: 153,
                  Height: 47.52,
                  key: 1,
                  scale: 1,
                  type: 'signature',
                  isStamp: false,
                  options: { name: 'signature', status: 'required' },
                },
              ],
            },
          ],
        },
      ]),
    );
  });
});
