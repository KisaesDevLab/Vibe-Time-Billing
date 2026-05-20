// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Rate resolution for a time entry.
//
// Hierarchy (most specific wins):
//   engagement_rate_override → client_rate_override → service_line_rate
//   → timekeeper_rate → firm default
//
// Effective-dating: each rate row has `effective_start` and optional
// `effective_end`. A rate applies on a given date if start <= date <
// (end ?? +∞). Multiple overlapping rows at the same hierarchy level
// resolve to the most-recently-started one (matches the time entry's
// service date semantics).

import type { Cents, IsoDate, Uuid } from '@vibe/types';

export interface RateCandidate {
  level: 'engagement' | 'client' | 'service_line' | 'timekeeper' | 'firm';
  appUserId?: Uuid | null;
  engagementId?: Uuid | null;
  clientId?: Uuid | null;
  serviceLineId?: Uuid | null;
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
  candidates: RateCandidate[];
  firmDefaultBillRateCents: Cents;
  firmDefaultCostRateCents?: Cents | null;
}

export interface ResolvedRate {
  level: RateCandidate['level'];
  billRateCents: Cents;
  costRateCents: Cents | null;
  /** Why this level won — useful for the rate-resolution debug panel (Phase 7 item 17). */
  trace: { level: RateCandidate['level']; status: 'win' | 'no-match' }[];
}

const LEVEL_ORDER: RateCandidate['level'][] = [
  'engagement',
  'client',
  'service_line',
  'timekeeper',
  'firm',
];

export function resolveRate(input: RateResolutionInput): ResolvedRate {
  const trace: ResolvedRate['trace'] = [];

  for (const level of LEVEL_ORDER) {
    if (level === 'firm') break; // handled below as the fallback
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
    case 'timekeeper':
      return c.appUserId === input.appUserId;
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
 */
export function captureRateSnapshot(args: { rate: ResolvedRate; hours: number }): {
  rateCents: Cents;
  amountCents: Cents;
} {
  return {
    rateCents: args.rate.billRateCents,
    amountCents: Math.round(args.rate.billRateCents * args.hours),
  };
}
