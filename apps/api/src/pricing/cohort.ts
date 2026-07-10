// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Cohort assembly + hours/cost-by-tier (PS Phases 2-3). Builds the structured
// inputs the deterministic engine consumes:
//   - cohort = engagements sharing (returnType/type + complexity bucket) billed
//     in the trailing 12 months;
//   - expected hours per tier (normalized: trimmed mean / median across the
//     cohort, INCLUDING zeros so a rarely-used tier contributes ~0);
//   - burdened cost per tier from the cohort's captured cost_rate_snapshot
//     (hours-weighted), falling back to the firm per-tier setting when thin.
// Tier = engagement_assignment.role; a person with several roles on one
// engagement is attributed to their MOST SENIOR role (deterministic).

import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clients,
  engagementAssignments,
  engagements,
  invoiceLineItems,
  invoices,
  taxReturnSections,
  taxReturns,
  timeEntries,
} from '@vibe/db/schema';
import {
  complexityBucket,
  expectedHours,
  type ComplexityBucket,
  type HoursStatistic,
  type RateTier,
} from '@vibe/core/pricing';

const TIERS: RateTier[] = ['PARTNER', 'MANAGER', 'REVIEWER', 'PREPARER', 'STAFF'];
const PRECEDENCE: Record<RateTier, number> = {
  PARTNER: 0,
  MANAGER: 1,
  REVIEWER: 2,
  PREPARER: 3,
  STAFF: 4,
};
const BILLED_STATUSES = ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] as const;
const COUNTED_TE_STATUSES = ['SUBMITTED', 'LOCKED', 'BILLED'] as const;

export interface TierAssembly {
  tier: RateTier;
  expectedHours: number;
  burdenedCostRateCents: number;
  cohortHasCostData: boolean;
}

export interface PricingInputAssembly {
  cohortSize: number;
  cohortEngagementIds: string[];
  complexity: ComplexityBucket;
  priorFeeCents: number | null;
  tiers: TierAssembly[];
  ownActualHoursByTier: Record<RateTier, number>;
  statistic: HoursStatistic;
  returnType: string | null;
}

interface FirmPricingSettings {
  pricingExpectedHoursStat: HoursStatistic;
  pricingBurdenedCostPerTier: Record<string, number>;
}

/** Count tax-return sections per engagement for a set of engagements. */
async function sectionCounts(db: Database, engIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (engIds.length === 0) return counts;
  const rows = await db
    .select({ engagementId: taxReturns.engagementId, n: sql<number>`count(*)::int` })
    .from(taxReturnSections)
    .innerJoin(taxReturns, eq(taxReturnSections.returnId, taxReturns.id))
    .where(inArray(taxReturns.engagementId, engIds))
    .groupBy(taxReturns.engagementId);
  for (const r of rows) if (r.engagementId) counts.set(r.engagementId, Number(r.n));
  return counts;
}

/** Resolve each (engagement, user) to a single MOST-SENIOR tier. */
function roleMap(
  rows: { engagementId: string; appUserId: string; role: RateTier }[],
): Map<string, RateTier> {
  const m = new Map<string, RateTier>();
  for (const r of rows) {
    const key = `${r.engagementId}:${r.appUserId}`;
    const cur = m.get(key);
    if (!cur || PRECEDENCE[r.role] < PRECEDENCE[cur]) m.set(key, r.role);
  }
  return m;
}

export async function assemblePricingInputs(
  db: Database,
  opts: { firmId: string; engagementId: string; settings: FirmPricingSettings },
): Promise<PricingInputAssembly> {
  const statistic = opts.settings.pricingExpectedHoursStat;

  const [subject] = await db
    .select({
      id: engagements.id,
      returnType: engagements.returnType,
      engagementTypeId: engagements.engagementTypeId,
      feeAmountCents: engagements.feeAmountCents,
    })
    .from(engagements)
    .where(eq(engagements.id, opts.engagementId))
    .limit(1);
  if (!subject) throw new Error('engagement_not_found');

  // Subject complexity from its tax-return section count.
  const subjectSections = (await sectionCounts(db, [subject.id])).get(subject.id) ?? 0;
  const complexity = complexityBucket(subjectSections);

  // Candidate engagements: same returnType (or type) billed in the trailing 12mo.
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  const typeMatch = subject.returnType
    ? eq(engagements.returnType, subject.returnType)
    : subject.engagementTypeId
      ? eq(engagements.engagementTypeId, subject.engagementTypeId)
      : sql`false`;

  const candidates = await db
    .selectDistinct({ id: engagements.id })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .innerJoin(invoiceLineItems, eq(invoiceLineItems.engagementId, engagements.id))
    .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
    .where(
      and(
        eq(clients.firmId, opts.firmId),
        typeMatch,
        ne(engagements.id, subject.id),
        ne(engagements.status, 'ARCHIVED'),
        inArray(invoices.status, [...BILLED_STATUSES]),
        gte(invoices.issueDate, cutoffISO),
      ),
    );
  let candidateIds = candidates.map((c) => c.id);

  // Keep candidates whose complexity bucket matches the subject (when tax-prep).
  if (complexity !== 'NA' && candidateIds.length > 0) {
    const counts = await sectionCounts(db, candidateIds);
    candidateIds = candidateIds.filter(
      (id) => complexityBucket(counts.get(id) ?? 0) === complexity,
    );
  }

  const cohortEngagementIds = candidateIds;
  const idsForAggregation = [...cohortEngagementIds, subject.id];

  // Role map + time entries for cohort + subject.
  const assigns =
    idsForAggregation.length > 0
      ? await db
          .select({
            engagementId: engagementAssignments.engagementId,
            appUserId: engagementAssignments.appUserId,
            role: engagementAssignments.role,
          })
          .from(engagementAssignments)
          .where(inArray(engagementAssignments.engagementId, idsForAggregation))
      : [];
  const roles = roleMap(assigns as { engagementId: string; appUserId: string; role: RateTier }[]);

  const tes =
    idsForAggregation.length > 0
      ? await db
          .select({
            engagementId: timeEntries.engagementId,
            appUserId: timeEntries.appUserId,
            hours: timeEntries.hours,
            costRate: timeEntries.costRateSnapshotCents,
            status: timeEntries.status,
          })
          .from(timeEntries)
          .where(
            and(
              inArray(timeEntries.engagementId, idsForAggregation),
              inArray(timeEntries.status, [...COUNTED_TE_STATUSES]),
            ),
          )
      : [];

  // Per-engagement per-tier hours; cohort cost accumulators by tier.
  const perEngTierHours = new Map<string, Record<RateTier, number>>();
  const costNum: Record<RateTier, number> = blankTier();
  const costDen: Record<RateTier, number> = blankTier();
  const ownActual: Record<RateTier, number> = blankTier();

  for (const te of tes) {
    const tier = roles.get(`${te.engagementId}:${te.appUserId}`) ?? 'STAFF';
    const hrs = Number(te.hours);
    if (!perEngTierHours.has(te.engagementId)) perEngTierHours.set(te.engagementId, blankTier());
    perEngTierHours.get(te.engagementId)![tier] += hrs;
    if (te.engagementId === subject.id) ownActual[tier] += hrs;
    if (te.engagementId !== subject.id && te.costRate != null && te.costRate > 0) {
      costNum[tier] += te.costRate * hrs;
      costDen[tier] += hrs;
    }
  }

  // Expected hours per tier across cohort engagements (zeros included).
  const tiers: TierAssembly[] = TIERS.map((tier) => {
    const series = cohortEngagementIds.map((id) => perEngTierHours.get(id)?.[tier] ?? 0);
    const hoursStat = expectedHours(series, statistic);
    const cohortRate = costDen[tier] > 0 ? Math.round(costNum[tier] / costDen[tier]) : 0;
    const fallback = Math.max(0, Math.round(opts.settings.pricingBurdenedCostPerTier[tier] ?? 0));
    return {
      tier,
      expectedHours: Number(hoursStat.toFixed(2)),
      burdenedCostRateCents: cohortRate > 0 ? cohortRate : fallback,
      cohortHasCostData: cohortRate > 0,
    };
  });

  return {
    cohortSize: cohortEngagementIds.length,
    cohortEngagementIds,
    complexity,
    priorFeeCents: subject.feeAmountCents ?? null,
    tiers,
    ownActualHoursByTier: ownActual,
    statistic,
    returnType: subject.returnType,
  };
}

function blankTier(): Record<RateTier, number> {
  return { PARTNER: 0, MANAGER: 0, REVIEWER: 0, PREPARER: 0, STAFF: 0 };
}
