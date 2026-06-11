// SPDX-License-Identifier: Elastic-2.0
//
// Merged-package field placement. A signing package is assembled from ordered
// parts (extracted return signature page(s), firm default-document templates,
// ad-hoc uploads). Each part contributes a contiguous page range in the
// merged PDF; this module places role-tagged fields on those pages and remaps
// them to the merged page numbers.
//
// Field layouts are keyed by `layoutKey` (set on each signature_page_rule):
//   us-8879     — 1040 8879: taxpayer + spouse signature/date lines.
//   entity-8879 — entity 8879-S/C/PE: officer signature/date.
//   state-auth  — generic state e-file authorization: taxpayer + spouse.
//   generic     — bottom-of-page taxpayer + spouse (engagement letters, etc.).
// Single vs MFJ is automatic: applyProfile drops a role with no matching
// signer, so a Taxpayer-only session places one signature, MFJ places two.

import { returnTypeFamily } from '@vibe/core/signatures';

import type { PageGeometry } from './geometry';
import { applyProfile, type AppliedPlacement, type ProfileField } from './profiles';

export type LayoutKey = 'us-8879' | 'entity-8879' | 'state-auth' | 'generic';

// Map a return's formCode to the signature `formType` used for KBA gating +
// display. Individual 1040 → bare '8879' (KBA-gated); entity returns → their
// non-KBA e-file authorization. Everything else keeps the return code.
export function signatureFormTypeForReturn(returnFormCode: string | null | undefined): string {
  const family = returnTypeFamily(returnFormCode);
  switch (family) {
    case '1040':
    case '1040-NR':
      return '8879';
    case '1120-S':
      return '8879-S';
    case '1120':
      return '8879-C';
    case '1065':
      return '8879-PE';
    default:
      return family || 'generic';
  }
}

// Sensible starting coordinates (normalized, top-left origin). Firms nudge
// per-session in the editor — these are NOT pixel-authoritative IRS spots.
const TAXPAYER_SPOUSE: ProfileField[] = [
  {
    role: 'taxpayer',
    fieldType: 'signature',
    pageNumber: 1,
    nx: 0.08,
    ny: 0.6,
    nw: 0.32,
    nh: 0.04,
  },
  { role: 'taxpayer', fieldType: 'date', pageNumber: 1, nx: 0.46, ny: 0.6, nw: 0.16, nh: 0.04 },
  { role: 'spouse', fieldType: 'signature', pageNumber: 1, nx: 0.08, ny: 0.72, nw: 0.32, nh: 0.04 },
  { role: 'spouse', fieldType: 'date', pageNumber: 1, nx: 0.46, ny: 0.72, nw: 0.16, nh: 0.04 },
];

export const SIGNATURE_PAGE_LAYOUTS: Record<LayoutKey, ProfileField[]> = {
  'us-8879': TAXPAYER_SPOUSE,
  'entity-8879': [
    {
      role: 'officer',
      fieldType: 'signature',
      pageNumber: 1,
      nx: 0.08,
      ny: 0.62,
      nw: 0.3,
      nh: 0.04,
    },
    { role: 'officer', fieldType: 'date', pageNumber: 1, nx: 0.42, ny: 0.62, nw: 0.15, nh: 0.04 },
  ],
  'state-auth': TAXPAYER_SPOUSE,
  generic: TAXPAYER_SPOUSE,
};

/** A part of the merged package occupying `[pageStart, pageEnd]` (1-based,
 *  inclusive) in the merged PDF, with the field layout to place on it. */
export interface PackagePart {
  source: 'return' | 'template' | 'adhoc';
  label: string;
  pageStart: number;
  pageEnd: number;
  /** Role-tagged fields in the part's OWN page space (1-based per part). */
  fields: ProfileField[];
  refId?: string;
}

export interface AssembledPlan {
  placements: AppliedPlacement[];
  unmatchedRoles: string[];
}

/** Resolve the field layout for a detected return page by its layoutKey. */
export function layoutForKey(layoutKey: string): ProfileField[] {
  return SIGNATURE_PAGE_LAYOUTS[layoutKey as LayoutKey] ?? SIGNATURE_PAGE_LAYOUTS.generic;
}

/**
 * Place fields for every part onto the merged page space. For each part we run
 * the part's role layout through applyProfile (matching the session's role-
 * assigned signers), then shift each placement's pageNumber by the part's
 * offset in the merged PDF (`mergedPage = pageStart + fieldPage - 1`). Pure.
 */
export function assemblePackagePlan(
  parts: PackagePart[],
  signers: Array<{ id: string; role: string | null }>,
  mergedGeometry: PageGeometry[],
): AssembledPlan {
  const placements: AppliedPlacement[] = [];
  const unmatched = new Set<string>();
  for (const part of parts) {
    const partPageCount = part.pageEnd - part.pageStart + 1;
    // Geometry in the part's own page space (1-based) for applyProfile's
    // page-existence check; the merged geometry slice is enough.
    const partGeometry: PageGeometry[] = [];
    for (let p = 1; p <= partPageCount; p += 1) {
      const merged = mergedGeometry.find((g) => g.pageNumber === part.pageStart + p - 1);
      if (merged) partGeometry.push({ ...merged, pageNumber: p });
    }
    const res = applyProfile(part.fields, signers, partGeometry);
    res.unmatchedRoles.forEach((r) => unmatched.add(r));
    for (const pl of res.placements) {
      placements.push({ ...pl, pageNumber: part.pageStart + pl.pageNumber - 1 });
    }
  }
  return { placements, unmatchedRoles: [...unmatched] };
}
