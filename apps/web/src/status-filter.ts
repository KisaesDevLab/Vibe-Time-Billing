// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0167 — shared client-side filtering of engagement workflow statuses by
// an engagement's service line. The catalog endpoints attach a
// `serviceLineIds` array to each status; this module decides which
// statuses a given engagement may be offered.
//
// Rule (a status is offered when ANY of these holds):
//   1. it has no service-line mappings (serviceLineIds is empty) ⇒ all,
//   2. the engagement's service line is in serviceLineIds,
//   3. the engagement has no service line (null) — can't filter, show all,
//   4. it is the engagement's current value — never hide what's already set.

export interface StatusWithLines {
  workflowState: string;
  serviceLineIds: string[];
}

export function allowedForServiceLine(
  status: StatusWithLines,
  serviceLineId: string | null,
  currentValue?: string,
): boolean {
  if (status.workflowState === currentValue) return true;
  if (status.serviceLineIds.length === 0) return true;
  if (serviceLineId == null) return true;
  return status.serviceLineIds.includes(serviceLineId);
}

export function filterStatuses<T extends StatusWithLines>(
  all: T[],
  serviceLineId: string | null,
  currentValue?: string,
): T[] {
  return all.filter((s) => allowedForServiceLine(s, serviceLineId, currentValue));
}

// Bulk variant — a status is offered only when it's allowed for EVERY
// engagement in the selection (intersection of the per-engagement rules).
// A status with no mappings, or a selection where every engagement is
// typeless, still passes. `currentValues` (the selected engagements'
// current states) are always kept so an already-set value is never hidden.
export function filterStatusesForMany<T extends StatusWithLines>(
  all: T[],
  serviceLineIds: Array<string | null>,
  currentValues: string[] = [],
): T[] {
  const current = new Set(currentValues);
  return all.filter(
    (s) =>
      current.has(s.workflowState) || serviceLineIds.every((sl) => allowedForServiceLine(s, sl)),
  );
}
