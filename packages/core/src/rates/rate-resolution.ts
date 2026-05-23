// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Rate resolution for a time entry.
//
// Hierarchy (most specific wins):
//   engagement_rate_override → client_rate_override → service_line_rate
//   → staff_rate (engagement's rate code) → staff_rate (StandardRate)
//   → firm default
//
// Migration 0054 replaced the flat timekeeper_rate with per-code
// snapshots. The `staff_rate` level pulls a rate for the engagement's
// configured rate code; if no entry exists for that code, the resolver
// falls back to the firm's StandardRate code on the same snapshot.
//
// Effective-dating: each rate row has `effective_start` and optional
// `effective_end`. A rate applies on a given date if start <= date <
// (end ?? +∞). Multiple overlapping rows at the same hierarchy level
// resolve to the most-recently-started one (matches the time entry's
// service date semantics). Snapshots are open-ended — the "current"
// snapshot at a given service date is the most recent one whose
// effective_date <= serviceDate.

import type { Cents, IsoDate, Uuid } from '@vibe/types';

export interface RateCandidate {
  level: 'engagement' | 'client' | 'service_line' | 'staff_rate' | 'firm';
  appUserId?: Uuid | null;
  engagementId?: Uuid | null;
  clientId?: Uuid | null;
  serviceLineId?: Uuid | null;
  /** Only set for level === 'staff_rate'. Identifies which rate code this entry came from. */
  rateCodeId?: Uuid | null;
  /** Only set for level === 'staff_rate'. True when this row came from the StandardRate code. */
  isStandardCode?: boolean;
  billRateCents: Cents;
  costRateCents?: Cents | null;
  effectiveStart: IsoDate;
  effectiveEnd?: IsoDate | null;
}

export interface RateResolutionInput {
  serviceDate: IsoDate;
  appUserId: Uuid;
  engagementId: Uuid;
  clientId: Uuid;
  serviceLineId?: Uuid | null;
  /**
   * The engagement's `default_rate_code_id`. NULL means the staff_rate
   * level will only consider StandardRate entries (the fallback path).
   */
  rateCodeId?: Uuid | null;
  candidates: RateCandidate[];
  firmDefaultBillRateCents: Cents;
  firmDefaultCostRateCents?: Cents | null;
}

export interface ResolvedRate {
  level: RateCandidate['level'];
  billRateCents: Cents;
  costRateCents: Cents | null;
  /** Which rate code the winning staff_rate row came from (if applicable). */
  rateCodeId?: Uuid | null;
  /** Why this level won — useful for the rate-resolution debug panel (Phase 7 item 17). */
  trace: { level: RateCandidate['level']; status: 'win' | 'no-match' | 'fallback' }[];
}

const LEVEL_ORDER: RateCandidate['level'][] = [
  'engagement',
  'client',
  'service_line',
  'staff_rate',
  'firm',
];

export function resolveRate(input: RateResolutionInput): ResolvedRate {
  const trace: ResolvedRate['trace'] = [];

  for (const level of LEVEL_ORDER) {
    if (level === 'firm') break; // handled below as the fallback
    if (level === 'staff_rate') {
      // Two-phase: prefer the engagement's rate code, fall back to
      // StandardRate. Both are flagged at candidate-build time so the
      // resolver doesn't need to know firm context.
      const all = input.candidates.filter(
        (c) =>
          c.level === 'staff_rate' &&
          c.appUserId === input.appUserId &&
          isEffective(c, input.serviceDate),
      );
      const codeMatches =
        input.rateCodeId != null ? all.filter((c) => c.rateCodeId === input.rateCodeId) : [];
      if (codeMatches.length > 0) {
        const winner = pickMostRecent(codeMatches);
        trace.push({ level: 'staff_rate', status: 'win' });
        return {
          level: 'staff_rate',
          billRateCents: winner.billRateCents,
          costRateCents: winner.costRateCents ?? null,
          rateCodeId: winner.rateCodeId ?? null,
          trace,
        };
      }
      const standardMatches = all.filter((c) => c.isStandardCode === true);
      if (standardMatches.length > 0) {
        const winner = pickMostRecent(standardMatches);
        trace.push({
          level: 'staff_rate',
          status: input.rateCodeId != null ? 'fallback' : 'win',
        });
        return {
          level: 'staff_rate',
          billRateCents: winner.billRateCents,
          costRateCents: winner.costRateCents ?? null,
          rateCodeId: winner.rateCodeId ?? null,
          trace,
        };
      }
      trace.push({ level: 'staff_rate', status: 'no-match' });
      continue;
    }
    const matches = input.candidates.filter(
      (c) => c.level === level && levelMatchesInput(c, input) && isEffective(c, input.serviceDate),
    );
    if (matches.length === 0) {
      trace.push({ level, status: 'no-match' });
      continue;
    }
    const winner = pickMostRecent(matches);
    trace.push({ level, status: 'win' });
    return {
      level,
      billRateCents: winner.billRateCents,
      costRateCents: winner.costRateCents ?? null,
      trace,
    };
  }

  trace.push({ level: 'firm', status: 'win' });
  return {
    level: 'firm',
    billRateCents: input.firmDefaultBillRateCents,
    costRateCents: input.firmDefaultCostRateCents ?? null,
    trace,
  };
}

function levelMatchesInput(c: RateCandidate, input: RateResolutionInput): boolean {
  switch (c.level) {
    case 'engagement':
      return c.engagementId === input.engagementId && c.appUserId === input.appUserId;
    case 'client':
      return c.clientId === input.clientId && c.appUserId === input.appUserId;
    case 'service_line':
      return (
        c.serviceLineId != null &&
        c.serviceLineId === input.serviceLineId &&
        c.appUserId === input.appUserId
      );
    case 'staff_rate':
      // Handled inline above (two-phase lookup).
      return false;
    case 'firm':
      return true;
  }
}

function isEffective(c: RateCandidate, serviceDate: IsoDate): boolean {
  if (c.effectiveStart > serviceDate) return false;
  if (c.effectiveEnd != null && c.effectiveEnd <= serviceDate) return false;
  return true;
}

function pickMostRecent(matches: RateCandidate[]): RateCandidate {
  return matches.reduce((best, cur) => (cur.effectiveStart > best.effectiveStart ? cur : best));
}

/**
 * Snapshot a rate at the time of writing a time entry. Stored on
 * `time_entry.standard_rate_snapshot_cents` and `standard_amount_cents`.
 * Historical reports never shift when rates change (CLAUDE.md
 * non-negotiable #3).
 *
 * Optional `multiplierBps` (Phase 7 #13) is the engagement-level
 * premium/discount in basis points: 10000 = 1.0x (default), 11000 =
 * +10% premium, 8500 = 15% discount. Applied to the resolved rate
 * BEFORE rounding so a 15% discount on a $420/hr rate snapshots as
 * $357/hr (not $420 stored then $357 displayed elsewhere).
 */
export function captureRateSnapshot(args: {
  rate: ResolvedRate;
  hours: number;
  multiplierBps?: number;
}): { rateCents: Cents; amountCents: Cents } {
  const bps = args.multiplierBps ?? 10000;
  const effectiveRate = Math.round((args.rate.billRateCents * bps) / 10000);
  return {
    rateCents: effectiveRate,
    amountCents: Math.round(effectiveRate * args.hours),
  };
}
