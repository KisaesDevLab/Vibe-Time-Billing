// SPDX-License-Identifier: Elastic-2.0
//
// PS Phases 2-3 — cohort assembly + hours/cost by tier over the T&B data.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  engagementAssignments,
  engagements,
  invoiceLineItems,
  invoices,
  timeEntries,
} from '@vibe/db/schema';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { assemblePricingInputs } from '../pricing/cohort';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

const SETTINGS = {
  pricingExpectedHoursStat: 'TRIMMED_MEAN' as const,
  pricingBurdenedCostPerTier: { REVIEWER: 9000 },
};

// Create a billed cohort engagement: 1040, one invoice (PAID, today), and
// `hours` of PREPARER time at the given burdened cost rate.
async function makeCohortEngagement(
  n: number,
  hours: number,
  costRateCents: number,
): Promise<void> {
  const [e] = await harness.db
    .insert(engagements)
    .values({
      clientId: seed.clientId,
      name: `Coh ${n}`,
      feeStructure: 'HOURLY',
      returnType: '1040',
    })
    .returning({ id: engagements.id });
  const [inv] = await harness.db
    .insert(invoices)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      invoiceNumber: `INV-${n}`,
      issueDate: new Date().toISOString().slice(0, 10),
      dueDate: new Date().toISOString().slice(0, 10),
      subtotalCents: 100000,
      totalCents: 100000,
      status: 'PAID',
    })
    .returning({ id: invoices.id });
  await harness.db.insert(invoiceLineItems).values({
    invoiceId: inv!.id,
    kind: 'TIME_AGGREGATE',
    description: 'time',
    amountCents: 100000,
    engagementId: e!.id,
  });
  await harness.db
    .insert(engagementAssignments)
    .values({ engagementId: e!.id, appUserId: seed.appUserId, role: 'PREPARER' });
  await harness.db.insert(timeEntries).values({
    engagementId: e!.id,
    appUserId: seed.appUserId,
    entryDate: new Date().toISOString().slice(0, 10),
    hours: String(hours),
    standardRateSnapshotCents: 20000,
    standardAmountCents: hours * 20000,
    costRateSnapshotCents: costRateCents,
    status: 'SUBMITTED',
  });
}

describe('pricing cohort assembly', () => {
  it('assembles a same-returnType cohort with hours + burdened cost by tier', async () => {
    await harness.db
      .update(engagements)
      .set({ returnType: '1040', feeAmountCents: 150000 })
      .where(eq(engagements.id, seed.engagementId));
    await makeCohortEngagement(1, 10, 6000);
    await makeCohortEngagement(2, 12, 6000);

    const r = await assemblePricingInputs(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      settings: SETTINGS,
    });

    expect(r.cohortSize).toBe(2);
    expect(r.priorFeeCents).toBe(150000);
    const prep = r.tiers.find((t) => t.tier === 'PREPARER')!;
    expect(prep.expectedHours).toBe(11); // trimmed mean of [10, 12]
    expect(prep.burdenedCostRateCents).toBe(6000); // hours-weighted cohort cost
    expect(prep.cohortHasCostData).toBe(true);
    // A tier with no cohort data uses the firm fallback ($90/h here).
    const reviewer = r.tiers.find((t) => t.tier === 'REVIEWER')!;
    expect(reviewer.expectedHours).toBe(0);
    expect(reviewer.burdenedCostRateCents).toBe(9000);
    expect(reviewer.cohortHasCostData).toBe(false);
  });

  it('returns an empty cohort when nothing matches', async () => {
    await harness.db
      .update(engagements)
      .set({ returnType: '1065' })
      .where(eq(engagements.id, seed.engagementId));
    const r = await assemblePricingInputs(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      settings: SETTINGS,
    });
    expect(r.cohortSize).toBe(0);
  });
});
