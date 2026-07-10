// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared allocation orchestration for adjustments. Wraps the six
// @vibe/core allocation methods behind one `runAllocation` entry point and
// resolves timekeeper roles. Extracted from adjustments/routes.ts so both
// the manual adjustment endpoint and the close-out true-up endpoint apply
// the identical per-timekeeper write-up/down math.

import { eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { roles, userRoles } from '@vibe/db/schema';
import type { AppUserRole } from '@vibe/types';
import {
  allocateCustomWeighted,
  allocateHierarchicalCascade,
  allocatePartnerAbsorbs,
  allocateProRataByHours,
  allocateProRataByValue,
  allocateSpecificEntries,
  type AllocationResult,
  type TimeEntryInput,
} from '@vibe/core';

export type AllocationMethod =
  | 'SPECIFIC_ENTRIES'
  | 'PRO_RATA_BY_VALUE'
  | 'PRO_RATA_BY_HOURS'
  | 'PARTNER_ABSORBS'
  | 'HIERARCHICAL_CASCADE'
  | 'CUSTOM_WEIGHTED';

/**
 * The subset of an adjustment payload that drives allocation. `totalAmountCents`
 * is signed (negative = write-down). Method-specific fields are required only
 * for the methods that consume them (validated inside runAllocation).
 */
export interface AllocationInput {
  allocationMethod: AllocationMethod;
  totalAmountCents: number;
  entrySelections?: { entryId: string; amountCents: number }[];
  cascadeOrder?: ('PARTNER' | 'MANAGER' | 'SENIOR' | 'STAFF' | 'ADMIN')[];
  weights?: { appUserId: string; weight: number }[];
  weightingMode?: 'PERCENT' | 'DOLLAR';
}

/** Dispatch to the chosen allocation method; throws on missing payload. */
export function runAllocation(
  input: AllocationInput,
  entries: TimeEntryInput[],
): AllocationResult[] {
  switch (input.allocationMethod) {
    case 'SPECIFIC_ENTRIES':
      if (!input.entrySelections) throw new Error('entrySelections required');
      return allocateSpecificEntries({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
        entrySelections: input.entrySelections,
      });
    case 'PRO_RATA_BY_VALUE':
      return allocateProRataByValue({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
      });
    case 'PRO_RATA_BY_HOURS':
      return allocateProRataByHours({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
      });
    case 'PARTNER_ABSORBS':
      return allocatePartnerAbsorbs({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
      });
    case 'HIERARCHICAL_CASCADE':
      if (!input.cascadeOrder) throw new Error('cascadeOrder required');
      return allocateHierarchicalCascade({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
        cascadeOrder: input.cascadeOrder,
      });
    case 'CUSTOM_WEIGHTED':
      if (!input.weights || !input.weightingMode) {
        throw new Error('weights and weightingMode required');
      }
      return allocateCustomWeighted({
        totalAmountCents: input.totalAmountCents,
        timeEntries: entries,
        weightingMode: input.weightingMode,
        weights: input.weights,
      });
  }
}

export const KNOWN_ROLES: AppUserRole[] = ['PARTNER', 'MANAGER', 'SENIOR', 'STAFF', 'ADMIN'];

/** Map app_user_id → canonical role (defaulting handled by the caller). */
export async function loadRolesForUsers(
  db: Database,
  userIds: string[],
): Promise<Map<string, AppUserRole>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: userRoles.appUserId, slug: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(inArray(userRoles.appUserId, userIds));
  const out = new Map<string, AppUserRole>();
  for (const r of rows) {
    const upper = r.slug.toUpperCase() as AppUserRole;
    if (KNOWN_ROLES.includes(upper)) out.set(r.userId, upper);
  }
  return out;
}
