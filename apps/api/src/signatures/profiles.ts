// SPDX-License-Identifier: Elastic-2.0
//
// Phase 10 — reusable, role-based, versioned placement profiles.
//
// A profile is a named set of field placements keyed by signer ROLE (not a
// specific person), so a firm calibrates "where the officer + ERO sign on
// an 8879-S" once and applies it to every entity return. Coordinates are
// normalized (survive any page scale); per-form versions let a firm retune
// without disturbing already-sent requests.
//
// IRS COMPLIANCE CONSTRAINT (addendum §8). Form 8879 has an individual-vs-
// entity asymmetry:
//   - ENTITY returns (1120-S → 8879-S, 1120 → 8879-C, 1065 → 8879-PE) are
//     satisfied by the signer authenticating through the portal (login +
//     MFA) — the entity path. These profiles are seeded.
//   - The INDIVIDUAL 1040 (Form 8879) requires Knowledge-Based
//     Authentication (KBA) when signed remotely. We do NOT seed a 1040
//     8879 profile, and the form registry marks `8879` as requiresKba so
//     the apply/send path refuses it unless a KBA flow is explicitly
//     attached. Never reuse the entity profiles for a 1040 send.

import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { signaturePlacementProfiles } from '@vibe/db/schema';

import type { PageGeometry } from './geometry';
import type { FieldType } from './adapter';

export interface ProfileField {
  role: string;
  fieldType: FieldType;
  pageNumber: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  required?: boolean;
}

export interface FormRegistryEntry {
  formType: string;
  label: string;
  /** Entity return — satisfied by portal login + MFA (no KBA). */
  entityOnly: boolean;
  /** Individual 1040 remote signing requires KBA; gate sends on it. */
  requiresKba: boolean;
}

// The forms we recognize. 8879-{S,C,PE} are the entity e-file
// authorizations; `8879` (bare) is the individual 1040 authorization and
// is KBA-gated. `engagement-letter` is a generic firm document.
export const SIGNATURE_FORM_REGISTRY: Record<string, FormRegistryEntry> = {
  '8879-S': {
    formType: '8879-S',
    label: 'Form 8879-S (1120-S)',
    entityOnly: true,
    requiresKba: false,
  },
  '8879-C': {
    formType: '8879-C',
    label: 'Form 8879-C (1120)',
    entityOnly: true,
    requiresKba: false,
  },
  '8879-PE': {
    formType: '8879-PE',
    label: 'Form 8879-PE (1065)',
    entityOnly: true,
    requiresKba: false,
  },
  '8879': { formType: '8879', label: 'Form 8879 (1040)', entityOnly: false, requiresKba: true },
  'engagement-letter': {
    formType: 'engagement-letter',
    label: 'Engagement Letter',
    entityOnly: false,
    requiresKba: false,
  },
};

// Whether a send for this form type is allowed without a KBA flow. The send
// pipeline + apply path consult this so a 1040 8879 can't go out the entity
// path by accident.
export function formRequiresKba(formType: string | null | undefined): boolean {
  if (!formType) return false;
  return SIGNATURE_FORM_REGISTRY[formType]?.requiresKba ?? false;
}

// Default placement coordinates are sensible starting points keyed to each
// form's signature blocks; firms recalibrate per their exact PDF via the
// editor (a new version). They are NOT pixel-authoritative IRS positions.
const ENTITY_8879_FIELDS: ProfileField[] = [
  // Part II — Officer's signature block.
  { role: 'officer', fieldType: 'signature', pageNumber: 1, nx: 0.08, ny: 0.62, nw: 0.3, nh: 0.04 },
  { role: 'officer', fieldType: 'date', pageNumber: 1, nx: 0.42, ny: 0.62, nw: 0.15, nh: 0.04 },
  // Part III — ERO's signature block.
  { role: 'ero', fieldType: 'signature', pageNumber: 1, nx: 0.08, ny: 0.82, nw: 0.3, nh: 0.04 },
  { role: 'ero', fieldType: 'date', pageNumber: 1, nx: 0.42, ny: 0.82, nw: 0.15, nh: 0.04 },
];

export const DEFAULT_PLACEMENT_PROFILES: Array<{
  formType: string;
  version: number;
  fields: ProfileField[];
}> = [
  { formType: '8879-S', version: 1, fields: ENTITY_8879_FIELDS },
  { formType: '8879-C', version: 1, fields: ENTITY_8879_FIELDS },
  { formType: '8879-PE', version: 1, fields: ENTITY_8879_FIELDS },
  {
    formType: 'engagement-letter',
    version: 1,
    fields: [
      // Generic last-page client signature + date.
      {
        role: 'client',
        fieldType: 'signature',
        pageNumber: 1,
        nx: 0.1,
        ny: 0.8,
        nw: 0.32,
        nh: 0.05,
      },
      { role: 'client', fieldType: 'date', pageNumber: 1, nx: 0.5, ny: 0.8, nw: 0.18, nh: 0.04 },
    ],
  },
];

/**
 * Seed the firm's default profiles (idempotent — skips a (formType,version)
 * that already exists). Returns the count inserted.
 */
export async function seedDefaultProfiles(db: Database, firmId: string): Promise<number> {
  let inserted = 0;
  for (const p of DEFAULT_PLACEMENT_PROFILES) {
    const existing = await db
      .select({ id: signaturePlacementProfiles.id })
      .from(signaturePlacementProfiles)
      .where(
        and(
          eq(signaturePlacementProfiles.firmId, firmId),
          eq(signaturePlacementProfiles.formType, p.formType),
          eq(signaturePlacementProfiles.version, p.version),
        ),
      )
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(signaturePlacementProfiles).values({
      firmId,
      formType: p.formType,
      version: p.version,
      fields: p.fields,
    });
    inserted += 1;
  }
  return inserted;
}

/** Latest version of each form's profile for a firm. */
export async function listLatestProfiles(db: Database, firmId: string) {
  const rows = await db
    .select()
    .from(signaturePlacementProfiles)
    .where(eq(signaturePlacementProfiles.firmId, firmId))
    .orderBy(desc(signaturePlacementProfiles.version));
  const byForm = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!byForm.has(r.formType)) byForm.set(r.formType, r);
  }
  return [...byForm.values()];
}

export interface AppliedPlacement {
  signerId: string;
  fieldType: FieldType;
  pageNumber: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  required: boolean;
}

export interface ApplyResult {
  placements: AppliedPlacement[];
  /** Profile roles with no matching signer (informational). */
  unmatchedRoles: string[];
}

/**
 * Expand a role-based profile onto concrete signers (matched by role,
 * case-insensitive). Fields whose page is absent from the geometry are
 * dropped (the caller re-validates anyway). Pure.
 */
export function applyProfile(
  fields: ProfileField[],
  signers: Array<{ id: string; role: string | null }>,
  geometry: PageGeometry[],
): ApplyResult {
  const pages = new Set(geometry.map((g) => g.pageNumber));
  const byRole = new Map<string, string[]>();
  for (const s of signers) {
    const role = (s.role ?? '').toLowerCase();
    const list = byRole.get(role) ?? [];
    list.push(s.id);
    byRole.set(role, list);
  }

  const placements: AppliedPlacement[] = [];
  const unmatchedRoles = new Set<string>();
  for (const f of fields) {
    const matches = byRole.get(f.role.toLowerCase());
    if (!matches || matches.length === 0) {
      unmatchedRoles.add(f.role);
      continue;
    }
    if (!pages.has(f.pageNumber)) continue;
    for (const signerId of matches) {
      placements.push({
        signerId,
        fieldType: f.fieldType,
        pageNumber: f.pageNumber,
        nx: f.nx,
        ny: f.ny,
        nw: f.nw,
        nh: f.nh,
        required: f.required ?? true,
      });
    }
  }
  return { placements, unmatchedRoles: [...unmatchedRoles] };
}
