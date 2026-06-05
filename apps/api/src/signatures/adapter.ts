// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase 5 — the coordinate adapter. THE ONLY place the normalized→OpenSign
// coordinate math lives, so it is fixture-tested in one spot.
//
// Confirmed against the deployed OpenSign server (createDocumentFromApp):
// placeholders are TOP-LEFT EDITOR PIXELS, not PDF points and not a
// bottom-left flip. OpenSign renders each page at a fixed width
// (`pdfNewWidth`, default 818) and a proportional height, then scales the
// placeholder pixels to the real PDF at sign time. So:
//
//   editorPageW = PDF_NEW_WIDTH
//   editorPageH = PDF_NEW_WIDTH * (heightPt / widthPt)
//   xPosition   = nx * editorPageW          (origin top-left)
//   yPosition   = ny * editorPageH
//   Width       = nw * editorPageW
//   Height      = nh * editorPageH
//
// Output groups by signer → page → pos[], matching the shape
// createDocumentFromApp stores verbatim into `Placeholders`.

import type { PageGeometry } from './geometry';

/** OpenSign's default editor render width in px. Verify against the
 *  deployed client's `pdfNewWidth` constant; the math is otherwise scale-
 *  invariant (it only sets the absolute pixel magnitude OpenSign rescales). */
export const PDF_NEW_WIDTH = 818;

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
  options: { name: string; status: string };
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
  opts: { pdfNewWidth?: number } = {},
): OpenSignPlaceholder[] {
  const W = opts.pdfNewWidth ?? PDF_NEW_WIDTH;
  const geoByPage = new Map(geometry.map((g) => [g.pageNumber, g]));
  let keyCounter = 1;

  return signers.map((signer, idx) => {
    const mine = placements.filter((p) => p.signerId === signer.signerId);
    // group placements by page
    const byPage = new Map<number, OpenSignPos[]>();
    for (const p of mine) {
      const geo = geoByPage.get(p.pageNumber);
      if (!geo) throw new Error(`no geometry for page ${p.pageNumber}`);
      const editorPageW = W;
      const editorPageH = W * (geo.heightPt / geo.widthPt);
      const pos: OpenSignPos = {
        xPosition: round(p.nx * editorPageW),
        yPosition: round(p.ny * editorPageH),
        Width: round(p.nw * editorPageW),
        Height: round(p.nh * editorPageH),
        key: keyCounter++,
        scale: 1,
        type: OPENSIGN_TYPE[p.fieldType],
        isStamp: false,
        options: { name: p.fieldType, status: p.required === false ? 'optional' : 'required' },
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
