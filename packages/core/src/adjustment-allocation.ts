// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase 12 stub. The companion test suite (adjustment-allocation.test.ts)
// is excluded from vitest runs until Phase 12 (see vitest.config.ts).
// Types and signatures exist so the build is import-clean today.

import type { AppUserRole, Cents, Hours, Uuid } from '@vibe/types';

export interface TimeEntryInput {
  id: Uuid;
  appUserId: Uuid;
  appUserRole: AppUserRole;
  hours: Hours;
  standardAmountCents: Cents;
}

export interface AllocationResult {
  timeEntryId: Uuid;
  appUserId: Uuid;
  appUserRole: AppUserRole;
  originalValueCents: Cents;
  adjustedValueCents: Cents;
  adjustmentAmountCents: Cents;
}

export interface SpecificEntriesInput {
  totalAmountCents: Cents;
  timeEntries: TimeEntryInput[];
  entrySelections: { entryId: Uuid; amountCents: Cents }[];
}

export interface ProRataInput {
  totalAmountCents: Cents;
  timeEntries: TimeEntryInput[];
}

export interface PartnerAbsorbsInput {
  totalAmountCents: Cents;
  timeEntries: TimeEntryInput[];
}

export interface HierarchicalCascadeInput {
  totalAmountCents: Cents;
  timeEntries: TimeEntryInput[];
  cascadeOrder: AppUserRole[];
}

export type CustomWeightingMode = 'PERCENT' | 'DOLLAR';

export interface CustomWeightedInput {
  totalAmountCents: Cents;
  timeEntries: TimeEntryInput[];
  weightingMode: CustomWeightingMode;
  weights: { appUserId: Uuid; weight: number }[];
}

const NOT_IMPL = (name: string): never => {
  throw new Error(`${name} not implemented yet — lands in Phase 12`);
};

export const allocateSpecificEntries = (_input: SpecificEntriesInput): AllocationResult[] =>
  NOT_IMPL('allocateSpecificEntries');

export const allocateProRataByValue = (_input: ProRataInput): AllocationResult[] =>
  NOT_IMPL('allocateProRataByValue');

export const allocateProRataByHours = (_input: ProRataInput): AllocationResult[] =>
  NOT_IMPL('allocateProRataByHours');

export const allocatePartnerAbsorbs = (_input: PartnerAbsorbsInput): AllocationResult[] =>
  NOT_IMPL('allocatePartnerAbsorbs');

export const allocateHierarchicalCascade = (_input: HierarchicalCascadeInput): AllocationResult[] =>
  NOT_IMPL('allocateHierarchicalCascade');

export const allocateCustomWeighted = (_input: CustomWeightedInput): AllocationResult[] =>
  NOT_IMPL('allocateCustomWeighted');
