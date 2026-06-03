// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R1 — Retainer eligibility check (D22).
//
// Phase 8 (R5) consumption logic calls this for every time entry to
// decide whether it draws from the retainer or goes straight to
// billable WIP. Returns an enum reason on miss so logs and the UI
// "preview" panel can render the right state.

export interface RetainerForEligibility {
  // R7 — 'paused' added so a firm can self-disable consumption
  // without voiding. The eligibility check treats it the same as
  // 'inactive' — entries route to billable WIP.
  // 0091 — 'pending_payment' added for firm-initiated billing; treated
  // as inactive until the retainer-purchase invoice is paid.
  status: 'active' | 'exhausted' | 'expired' | 'void' | 'paused' | 'pending_payment';
  expiryDate: string; // ISO date, e.g. '2029-04-15'
}

export type EligibilityResult =
  | { ok: true }
  | { ok: false; reason: 'inactive' | 'expired' | 'wrong_code' };

/**
 * Decide whether a time entry is eligible to consume from the retainer.
 *
 * D22 — entry on exact expiry_date is eligible (entryDate <= expiryDate).
 * The order of checks is intentional: status first, then expiry, then
 * work-code membership. The dashboard split-preview UI uses the reason
 * to pick the right muted-info-panel variant.
 */
export function isEligibleEntry(args: {
  retainer: RetainerForEligibility;
  entryDate: string; // ISO date
  workCodeId: string | null;
  eligibleWorkCodeIds: ReadonlyArray<string>;
}): EligibilityResult {
  if (args.retainer.status !== 'active') {
    return { ok: false, reason: 'inactive' };
  }
  if (args.entryDate > args.retainer.expiryDate) {
    return { ok: false, reason: 'expired' };
  }
  if (!args.workCodeId) {
    return { ok: false, reason: 'wrong_code' };
  }
  if (!args.eligibleWorkCodeIds.includes(args.workCodeId)) {
    return { ok: false, reason: 'wrong_code' };
  }
  return { ok: true };
}
