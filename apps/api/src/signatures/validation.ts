// SPDX-License-Identifier: Elastic-2.0
//
// Phase 4 — server-side placement validation. Pure + field-level so both
// the placement-save endpoint and the send gate (P6) reject the same way:
//   - geometry must exist (you can't place fields before the PDF upload
//     captures per-page point dims);
//   - every field's page must exist in the geometry;
//   - normalized coords ∈ [0,1] AND stay inside the page (nx+nw ≤ 1, etc.)
//     with positive width/height;
//   - every signer owns ≥1 SIGNATURE field (a placeless signer can't sign).
//
// The browser editor clamps as you drag, but the server never trusts it —
// these are the authoritative checks.

import type { PageGeometry } from './geometry';
import type { FieldType } from './adapter';

export const FIELD_TYPES: readonly FieldType[] = [
  'signature',
  'initials',
  'date',
  'text',
  'checkbox',
];

export interface PlacementInput {
  signerId: string;
  fieldType: FieldType;
  pageNumber: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  required?: boolean;
}

export interface ValidationError {
  /** Dotted path to the offending field, e.g. `placements[2].nx`. */
  path: string;
  message: string;
}

function inUnit(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Validate a full placement set against the request's signers + geometry.
 * Returns ALL errors (never throws) so the API can surface them field-by-
 * field. An empty array means the set is valid + sendable.
 */
export function validatePlacements(
  signerIds: string[],
  placements: PlacementInput[],
  geometry: PageGeometry[] | null | undefined,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!geometry || geometry.length === 0) {
    errors.push({ path: 'geometry', message: 'geometry_required' });
    // Without geometry we can't validate pages/bounds meaningfully.
    return errors;
  }

  const pages = new Set(geometry.map((g) => g.pageNumber));
  const signerSet = new Set(signerIds);
  const signersWithSignature = new Set<string>();

  placements.forEach((p, i) => {
    const at = `placements[${i}]`;
    if (!signerSet.has(p.signerId)) {
      errors.push({ path: `${at}.signerId`, message: 'unknown_signer' });
    }
    if (!FIELD_TYPES.includes(p.fieldType)) {
      errors.push({ path: `${at}.fieldType`, message: 'invalid_field_type' });
    }
    if (!pages.has(p.pageNumber)) {
      errors.push({ path: `${at}.pageNumber`, message: 'page_not_in_document' });
    }
    for (const k of ['nx', 'ny', 'nw', 'nh'] as const) {
      if (!inUnit(p[k])) errors.push({ path: `${at}.${k}`, message: 'out_of_unit_range' });
    }
    if (inUnit(p.nw) && p.nw <= 0) errors.push({ path: `${at}.nw`, message: 'non_positive_size' });
    if (inUnit(p.nh) && p.nh <= 0) errors.push({ path: `${at}.nh`, message: 'non_positive_size' });
    if (inUnit(p.nx) && inUnit(p.nw) && p.nx + p.nw > 1) {
      errors.push({ path: `${at}.nx`, message: 'extends_past_page_width' });
    }
    if (inUnit(p.ny) && inUnit(p.nh) && p.ny + p.nh > 1) {
      errors.push({ path: `${at}.ny`, message: 'extends_past_page_height' });
    }
    if (p.fieldType === 'signature' && signerSet.has(p.signerId)) {
      signersWithSignature.add(p.signerId);
    }
  });

  // Every signer must own at least one signature field.
  for (const id of signerIds) {
    if (!signersWithSignature.has(id)) {
      errors.push({ path: `signer:${id}`, message: 'signer_has_no_signature_field' });
    }
  }

  return errors;
}
