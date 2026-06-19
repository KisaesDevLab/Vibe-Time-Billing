// SPDX-License-Identifier: Elastic-2.0
//
// PS Phases 7-8 — end-to-end suggestion: cohort → engine → rationale, and the
// AI-failure graceful degradation (PS-22: a number + templated rationale even
// when the AI call throws).

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
import { computePricingSuggestion, type PricingSettingsRow } from '../pricing/service';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

const SETTINGS: PricingSettingsRow = {
  pricingEconomicSource: 'MANUAL',
  pricingEconomicManualPct: '3',
  pricingTargetMarginPct: '40',
  pricingExpectedHoursStat: 'TRIMMED_MEAN',
  pricingCohortMin: 2,
  pricingBurdenedCostPerTier: {},
};

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

describe('pricing suggestion (end-to-end)', () => {
  beforeEach(async () => {
    await harness.db
      .update(engagements)
      .set({ returnType: '1040', feeAmountCents: 150000 })
      .where(eq(engagements.id, seed.engagementId));
    await makeCohortEngagement(1, 10, 6000);
    await makeCohortEngagement(2, 12, 6000);
  });

  it('PS-22 — AI failure degrades to a templated rationale, number still produced', async () => {
    const s = await computePricingSuggestion(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      settings: SETTINGS,
      aiComplete: () => {
        throw new Error('provider down');
      },
    });
    expect(s.price.mode).toBe('COST_BUILD');
    expect(s.price.costBaseCents).toBe(66000); // 11h × $60
    expect(s.price.grossedUpCents).toBe(110000); // ÷0.60
    expect(s.price.suggestedCents).toBe(113300); // ×1.03
    expect(s.rationale.source).toBe('TEMPLATE');
    expect(s.rationale.text).toContain('$');
  });

  it('uses the AI rationale when the provider returns text', async () => {
    const s = await computePricingSuggestion(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      settings: SETTINGS,
      aiComplete: async () => 'A bespoke partner-ready rationale.',
    });
    expect(s.rationale.source).toBe('AI');
    expect(s.rationale.text).toBe('A bespoke partner-ready rationale.');
    expect(s.price.suggestedCents).toBe(113300); // engine still owns the number
  });

  it('honors edited drivers (live recompute)', async () => {
    const s = await computePricingSuggestion(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      settings: SETTINGS,
      overrides: { targetMarginPct: 50, economicFactorPct: 0 },
      aiComplete: null,
    });
    expect(s.price.grossedUpCents).toBe(132000); // 66000 / 0.50
    expect(s.price.suggestedCents).toBe(132000); // econ 0
  });
});
