// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Rollforward Phase 3: a batch builds engagement candidates with suggested
// next-year due + drop-off dates from the prior-year engagement.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { clientRequests, engagements, rollforwardEngagementCandidates } from '@vibe/db/schema';

// UTC weekday (0=Sun…6=Sat) of a YYYY-MM-DD string, library-free.
const utcDow = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createRollforwardBatch } from '../rollforward/service';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('rollforward engagement candidates', () => {
  it('rolls the due date + drop-off forward, deadline-anchored', async () => {
    // Make the seeded engagement a 1040 due 2025-04-01, assigned to the staff,
    // with a drop-off two weeks earlier.
    await harness.db
      .update(engagements)
      .set({
        returnType: '1040',
        dueDate: '2025-04-01',
        partnerId: seed.appUserId,
        feeAmountCents: 50000,
      })
      .where(eq(engagements.id, seed.engagementId));
    await harness.db.insert(clientRequests).values({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'Document drop-off',
      kind: 'DROP_OFF',
      dueDate: '2025-03-18',
    });

    const { batchId, engagementCount } = await createRollforwardBatch(harness.db, {
      firmId: seed.firmId,
      staffId: seed.appUserId,
      sourceStart: '2025-02-01',
      sourceEnd: '2025-04-15',
      targetYear: 2026,
      mode: 'DEADLINE',
      createdByAppUserId: seed.appUserId,
    });
    expect(engagementCount).toBe(1);

    const [cand] = await harness.db
      .select()
      .from(rollforwardEngagementCandidates)
      .where(eq(rollforwardEngagementCandidates.batchId, batchId));
    expect(cand!.sourceDueDate).toBe('2025-04-01');
    expect(cand!.suggestedDueDate).toBeTruthy();
    expect(cand!.suggestedDropoffDate).toBeTruthy();
    // Same weekday preserved (Tuesday for 2025-04-01).
    expect(utcDow(cand!.suggestedDueDate!)).toBe(utcDow('2025-04-01'));
    expect(cand!.suggestedDueDate!.startsWith('2026-')).toBe(true);
    expect(cand!.status).toBe('PENDING');
    expect(cand!.sourceFeeCents).toBe(50000);
  });

  it('excludes engagements outside the source window', async () => {
    await harness.db
      .update(engagements)
      .set({ returnType: '1040', dueDate: '2025-09-30', partnerId: seed.appUserId })
      .where(eq(engagements.id, seed.engagementId));
    const { engagementCount } = await createRollforwardBatch(harness.db, {
      firmId: seed.firmId,
      staffId: seed.appUserId,
      sourceStart: '2025-02-01',
      sourceEnd: '2025-04-15',
      targetYear: 2026,
      mode: 'DEADLINE',
      createdByAppUserId: seed.appUserId,
    });
    expect(engagementCount).toBe(0);
  });
});
