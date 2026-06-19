// SPDX-License-Identifier: Elastic-2.0
//
// Tier-2 sanity overlays (PS Phase 6). These do NOT pick the number — they
// validate/flag the Tier-1 figure against what the firm has historically
// billed/realized. Computed against BILLABLE values (vs Tier-1's burdened
// cost — intentional; do not unify):
//   - Realization: subject engagement's adjusted ÷ original over trailing N yrs.
//     Persistent under-realization reinforces a raise.
//   - Below-cohort: subject's effective rate (billed ÷ billable hours) vs the
//     cohort median. A rate well below median flags legacy underpricing.

import { and, eq, gte, inArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  adjustmentAllocations,
  adjustments,
  invoiceLineItems,
  invoices,
  timeEntries,
} from '@vibe/db/schema';
import { effectiveRate } from '@vibe/core/reporting';
import { median } from '@vibe/core/pricing';

const BILLED_STATUSES = ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] as const;
const COUNTED_TE_STATUSES = ['SUBMITTED', 'LOCKED', 'BILLED'] as const;

export interface SanitySignal {
  key: 'realization' | 'below_cohort';
  agreesRaise: boolean;
  text: string;
}

export interface SanitySignals {
  realizationPct: number | null;
  subjectEffectiveRateCents: number | null;
  cohortMedianEffectiveRateCents: number | null;
  belowCohortPct: number | null;
  signals: SanitySignal[];
}

const dollars = (cents: number): string => `$${Math.round(cents / 100).toLocaleString()}`;

export async function computeSanitySignals(
  db: Database,
  opts: { subjectEngagementId: string; cohortEngagementIds: string[]; trailingYears?: number },
): Promise<SanitySignals> {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - (opts.trailingYears ?? 3));
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  // --- Realization (subject, trailing window) ---
  const [real] = await db
    .select({
      orig: sql<number>`coalesce(sum(${adjustmentAllocations.originalValueCents}), 0)::bigint`,
      adj: sql<number>`coalesce(sum(${adjustmentAllocations.adjustedValueCents}), 0)::bigint`,
    })
    .from(adjustmentAllocations)
    .innerJoin(adjustments, eq(adjustments.id, adjustmentAllocations.adjustmentId))
    .innerJoin(timeEntries, eq(timeEntries.id, adjustmentAllocations.timeEntryId))
    .where(
      and(
        eq(adjustments.status, 'APPLIED'),
        eq(timeEntries.engagementId, opts.subjectEngagementId),
        gte(timeEntries.entryDate, cutoffISO),
      ),
    );
  const orig = Number(real?.orig ?? 0);
  const realizationPct = orig > 0 ? Number((Number(real?.adj ?? 0) / orig).toFixed(4)) : null;

  // --- Effective rate: subject vs cohort median ---
  const allIds = [...opts.cohortEngagementIds, opts.subjectEngagementId];
  const billedRows = await db
    .select({
      engagementId: invoiceLineItems.engagementId,
      billed: sql<number>`coalesce(sum(${invoiceLineItems.amountCents}), 0)::bigint`,
    })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
    .where(
      and(
        inArray(invoiceLineItems.engagementId, allIds),
        inArray(invoices.status, [...BILLED_STATUSES]),
        gte(invoices.issueDate, cutoffISO),
      ),
    )
    .groupBy(invoiceLineItems.engagementId);
  const hourRows = await db
    .select({
      engagementId: timeEntries.engagementId,
      hours: sql<number>`coalesce(sum(${timeEntries.hours}) filter (where ${timeEntries.billableFlag}), 0)`,
    })
    .from(timeEntries)
    .where(
      and(
        inArray(timeEntries.engagementId, allIds),
        inArray(timeEntries.status, [...COUNTED_TE_STATUSES]),
      ),
    )
    .groupBy(timeEntries.engagementId);

  const billedBy = new Map(billedRows.map((r) => [r.engagementId, Number(r.billed)]));
  const hoursBy = new Map(hourRows.map((r) => [r.engagementId, Number(r.hours)]));
  const rateFor = (id: string): number | null => {
    const hrs = hoursBy.get(id) ?? 0;
    if (hrs <= 0) return null;
    return effectiveRate({ billedCents: billedBy.get(id) ?? 0, hours: hrs });
  };
  const subjectRate = rateFor(opts.subjectEngagementId);
  const cohortRates = opts.cohortEngagementIds
    .map(rateFor)
    .filter((r): r is number => r != null && r > 0);
  const cohortMedian = cohortRates.length > 0 ? Math.round(median(cohortRates)) : null;
  const belowCohortPct =
    subjectRate != null && cohortMedian && cohortMedian > 0
      ? Number((((cohortMedian - subjectRate) / cohortMedian) * 100).toFixed(1))
      : null;

  // --- Human-readable signals ---
  const signals: SanitySignal[] = [];
  if (realizationPct != null) {
    const under = realizationPct < 0.98;
    signals.push({
      key: 'realization',
      agreesRaise: under,
      text: under
        ? `Realization ${Math.round(realizationPct * 100)}% over the trailing window — persistent write-downs support a higher fee.`
        : `Realization ${Math.round(realizationPct * 100)}% — billing close to standard value; little write-down pressure.`,
    });
  }
  if (subjectRate != null && cohortMedian != null && belowCohortPct != null) {
    const below = belowCohortPct > 5;
    signals.push({
      key: 'below_cohort',
      agreesRaise: below,
      text: below
        ? `Effective rate ${dollars(subjectRate)}/h is ${belowCohortPct}% below the cohort median ${dollars(cohortMedian)}/h — likely legacy underpricing.`
        : `Effective rate ${dollars(subjectRate)}/h is in line with the cohort median ${dollars(cohortMedian)}/h.`,
    });
  }

  return {
    realizationPct,
    subjectEffectiveRateCents: subjectRate,
    cohortMedianEffectiveRateCents: cohortMedian,
    belowCohortPct,
    signals,
  };
}
