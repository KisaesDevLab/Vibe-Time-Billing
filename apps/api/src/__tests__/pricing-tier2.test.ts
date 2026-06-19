// SPDX-License-Identifier: Elastic-2.0
//
// PS Phase 6 — Tier-2 sanity overlays (below-cohort-median effective rate).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { engagements, invoiceLineItems, invoices, timeEntries } from '@vibe/db/schema';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { computeSanitySignals } from '../pricing/tier2';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

// Bill `billedCents` against `hours` billable hours on an engagement.
async function bill(engId: string, n: number, billedCents: number, hours: number): Promise<void> {
  const [inv] = await harness.db
    .insert(invoices)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      invoiceNumber: `INV-${n}`,
      issueDate: new Date().toISOString().slice(0, 10),
      dueDate: new Date().toISOString().slice(0, 10),
      subtotalCents: billedCents,
      totalCents: billedCents,
      status: 'PAID',
    })
    .returning({ id: invoices.id });
  await harness.db.insert(invoiceLineItems).values({
    invoiceId: inv!.id,
    kind: 'TIME_AGGREGATE',
    description: 'time',
    amountCents: billedCents,
    engagementId: engId,
  });
  await harness.db.insert(timeEntries).values({
    engagementId: engId,
    appUserId: seed.appUserId,
    entryDate: new Date().toISOString().slice(0, 10),
    hours: String(hours),
    standardRateSnapshotCents: 20000,
    standardAmountCents: hours * 20000,
    status: 'SUBMITTED',
  });
}

describe('tier-2 sanity overlays', () => {
  it('flags a subject priced below the cohort median effective rate', async () => {
    // Subject: $500 over 10h → $50/h.
    await bill(seed.engagementId, 0, 50000, 10);
    // Cohort: two engagements at ~$200/h.
    const [c1] = await harness.db
      .insert(engagements)
      .values({ clientId: seed.clientId, name: 'C1', feeStructure: 'HOURLY' })
      .returning({ id: engagements.id });
    const [c2] = await harness.db
      .insert(engagements)
      .values({ clientId: seed.clientId, name: 'C2', feeStructure: 'HOURLY' })
      .returning({ id: engagements.id });
    await bill(c1!.id, 1, 200000, 10);
    await bill(c2!.id, 2, 200000, 10);

    const r = await computeSanitySignals(harness.db, {
      subjectEngagementId: seed.engagementId,
      cohortEngagementIds: [c1!.id, c2!.id],
    });
    expect(r.subjectEffectiveRateCents).toBe(5000); // $50/h
    expect(r.cohortMedianEffectiveRateCents).toBe(20000); // $200/h
    expect(r.belowCohortPct).toBe(75);
    const below = r.signals.find((s) => s.key === 'below_cohort')!;
    expect(below.agreesRaise).toBe(true);
    // No applied adjustments → no realization signal.
    expect(r.realizationPct).toBeNull();
  });
});
