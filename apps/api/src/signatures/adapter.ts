// SPDX-License-Identifier: Elastic-2.0
//
// Phase 5 — the coordinate adapter. THE ONLY place the normalized→OpenSign
// coordinate math lives, so it is fixture-tested in one spot.
//
// Re-confirmed 2026-06-09 against the deployed OpenSign CLIENT (the server's
// createDocumentFromApp just stores Placeholders verbatim; the server's
// signing path receives a base64 PDF the client already stamped — it never
// consumes the coordinates). The client positions a widget at
//
//   displayed_px = pos.value * containerScale
//   containerScale = renderedContainerWidth / pdfOriginalWH[page].width
//
// where `pdfOriginalWH[page].width` is the PDF page's width in POINTS
// (pdf.js getViewport({scale:1}); Letter = 612, A4 ≈ 595.28). For a widget
// to land at fraction `nx` of the page width, pos.value / widthPt must equal
// nx — i.e. coordinates are PDF POINTS, top-left origin, NOT editor pixels
// at a fixed 818 and NOT a bottom-left flip. So:
//
//   xPosition = nx * widthPt          (origin top-left)
//   yPosition = ny * heightPt
//   Width     = nw * widthPt
//   Height    = nh * heightPt
//
// (The earlier 818-px scaling over-scaled every coordinate by 818/widthPt
// ≈ 1.34×, drifting fields right/down proportional to their distance from
// the top-left origin — the "signature in the wrong place" bug.)
//
// Output groups by signer → page → pos[], matching the shape
// createDocumentFromApp stores verbatim into `Placeholders`.

import type { PageGeometry } from './geometry';

export type FieldType = 'signature' | 'initials' | 'date' | 'text' | 'checkbox';

// OpenSign widget `type` vocabulary differs from ours; map at the boundary.
const OPENSIGN_TYPE: Record<FieldType, string> = {
  signature: 'signature',
  initials: 'initials',
  date: 'date',
  text: 'textbox',
  checkbox: 'checkbox',
};

export interface AdapterSigner {
  /** Our signer row id (used to match placements). */
  signerId: string;
  /** OpenSign contact objectId (resolved at send time via savecontact). */
  opensignContactId: string;
  role?: string | null;
  /** Per-signer pen/highlight color for the OpenSign editor. */
  color: string;
}

export interface AdapterPlacement {
  signerId: string;
  fieldType: FieldType;
  pageNumber: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  required?: boolean;
}

export interface OpenSignPos {
  xPosition: number;
  yPosition: number;
  Width: number;
  Height: number;
  key: number;
  scale: number;
  type: string;
  isStamp: boolean;
  // `response: 'today'` + a date-format validation makes OpenSign's signing
  // page pre-fill a date widget with the current date (getDefaultDate('today')
  // → new Date()); the signer can still change it. Non-date widgets omit these.
  options: {
    name: string;
    status: string;
    response?: string;
    validation?: { type: string; format: string };
  };
}

export interface OpenSignPlaceholder {
  Id: number;
  signerObjId: string;
  signerPtr: { __type: 'Pointer'; className: 'contracts_Contactbook'; objectId: string };
  Role?: string;
  blockColor: string;
  placeHolder: Array<{ pageNumber: number; pos: OpenSignPos[] }>;
}

function round(n: number): number {
  // OpenSign tolerates floats; round to keep payloads stable + readable.
  return Math.round(n * 100) / 100;
}

/**
 * Map normalized field placements onto OpenSign's editor-pixel Placeholders
 * shape, grouped by signer → page. Pure + deterministic.
 */
export function toOpenSignPlaceholder(
  signers: AdapterSigner[],
  placements: AdapterPlacement[],
  geometry: PageGeometry[],
): OpenSignPlaceholder[] {
  const geoByPage = new Map(geometry.map((g) => [g.pageNumber, g]));
  let keyCounter = 1;

  return signers.map((signer, idx) => {
    const mine = placements.filter((p) => p.signerId === signer.signerId);
    // group placements by page
    const byPage = new Map<number, OpenSignPos[]>();
    for (const p of mine) {
      const geo = geoByPage.get(p.pageNumber);
      if (!geo) throw new Error(`no geometry for page ${p.pageNumber}`);
      // OpenSign coordinates are PDF points (top-left origin); the client
      // scales them by renderedWidth/widthPt at render + sign time.
      const editorPageW = geo.widthPt;
      const editorPageH = geo.heightPt;
      const pos: OpenSignPos = {
        xPosition: round(p.nx * editorPageW),
        yPosition: round(p.ny * editorPageH),
        Width: round(p.nw * editorPageW),
        Height: round(p.nh * editorPageH),
        key: keyCounter++,
        scale: 1,
        type: OPENSIGN_TYPE[p.fieldType],
        isStamp: false,
        options: {
          name: p.fieldType,
          status: p.required === false ? 'optional' : 'required',
          // Default date fields to today's date on the signing page.
          ...(p.fieldType === 'date'
            ? {
                response: 'today',
                validation: { type: 'date-format', format: 'MM/dd/yyyy' },
              }
            : {}),
        },
      };
      const list = byPage.get(p.pageNumber) ?? [];
      list.push(pos);
      byPage.set(p.pageNumber, list);
    }

    const placeHolder = Array.from(byPage.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([pageNumber, pos]) => ({ pageNumber, pos }));

    return {
      Id: idx + 1,
      signerObjId: signer.opensignContactId,
      signerPtr: {
        __type: 'Pointer',
        className: 'contracts_Contactbook',
        objectId: signer.opensignContactId,
      },
      Role: signer.role ?? undefined,
      blockColor: signer.color,
      placeHolder,
    };
  });
}
