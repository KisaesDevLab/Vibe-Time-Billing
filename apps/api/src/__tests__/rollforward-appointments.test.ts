// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Rollforward Phase 4: appointment candidates for approved engagements +
// conflict detection against existing appointments.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  appointmentStaff,
  appointments,
  rollforwardAppointmentCandidates,
  rollforwardBatches,
  rollforwardEngagementCandidates,
} from '@vibe/db/schema';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { buildAppointmentCandidates, recomputeConflicts } from '../rollforward/appointments';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

async function setup(): Promise<{ batchId: string }> {
  const [batch] = await harness.db
    .insert(rollforwardBatches)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      sourceStart: '2025-02-01',
      sourceEnd: '2025-04-15',
      targetYear: 2026,
      mappingMode: 'DEADLINE',
    })
    .returning({ id: rollforwardBatches.id });
  await harness.db.insert(rollforwardEngagementCandidates).values({
    batchId: batch!.id,
    firmId: seed.firmId,
    sourceEngagementId: seed.engagementId,
    clientId: seed.clientId,
    clientName: 'Acme',
    returnType: '1040',
    status: 'APPROVED',
  });
  const [appt] = await harness.db
    .insert(appointments)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      engagementId: seed.engagementId,
      title: 'Tax review',
      startsAt: new Date('2025-04-01T15:00:00Z'),
      endsAt: new Date('2025-04-01T16:00:00Z'),
      durationMinutes: 60,
      status: 'SCHEDULED',
    })
    .returning({ id: appointments.id });
  await harness.db
    .insert(appointmentStaff)
    .values({ appointmentId: appt!.id, staffId: seed.appUserId });
  return { batchId: batch!.id };
}

describe('rollforward appointment candidates', () => {
  it('builds a candidate for an approved engagement; no conflict on an open day', async () => {
    const { batchId } = await setup();
    const n = await buildAppointmentCandidates(harness.db, {
      batchId,
      firmId: seed.firmId,
      targetYear: 2026,
      mode: 'DEADLINE',
    });
    expect(n).toBe(1);
    const [cand] = await harness.db
      .select()
      .from(rollforwardAppointmentCandidates)
      .where(eq(rollforwardAppointmentCandidates.batchId, batchId));
    expect(cand!.suggestedStartsAt).toBeTruthy();
    expect(cand!.suggestedStartsAt!.getUTCFullYear()).toBe(2026);
    expect(cand!.durationMinutes).toBe(60);
    expect(cand!.conflict).toBe(false);
  });

  it('flags a conflict when an existing appointment overlaps the suggested slot', async () => {
    const { batchId } = await setup();
    await buildAppointmentCandidates(harness.db, {
      batchId,
      firmId: seed.firmId,
      targetYear: 2026,
      mode: 'DEADLINE',
    });
    const [cand] = await harness.db
      .select()
      .from(rollforwardAppointmentCandidates)
      .where(eq(rollforwardAppointmentCandidates.batchId, batchId));
    // Drop an existing appointment for the same staff right on the suggested slot.
    const start = cand!.suggestedStartsAt!;
    const [busy] = await harness.db
      .insert(appointments)
      .values({
        firmId: seed.firmId,
        title: 'Existing',
        startsAt: start,
        endsAt: new Date(start.getTime() + 30 * 60_000),
        durationMinutes: 30,
        status: 'SCHEDULED',
      })
      .returning({ id: appointments.id });
    await harness.db
      .insert(appointmentStaff)
      .values({ appointmentId: busy!.id, staffId: seed.appUserId });

    await recomputeConflicts(harness.db, batchId);
    const [after] = await harness.db
      .select()
      .from(rollforwardAppointmentCandidates)
      .where(eq(rollforwardAppointmentCandidates.id, cand!.id));
    expect(after!.conflict).toBe(true);
  });
});
