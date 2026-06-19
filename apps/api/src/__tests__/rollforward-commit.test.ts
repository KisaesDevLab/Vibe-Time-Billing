// SPDX-License-Identifier: Elastic-2.0
//
// Rollforward Phases 5/7 end-to-end: preview → approve → commit creates the
// target engagement (DRAFT), its rolled drop-off, and the appointment; a
// re-commit is a no-op (idempotent).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { and, eq, ne } from 'drizzle-orm';

import {
  appointmentStaff,
  appointments,
  clientRequests,
  engagements,
  rollforwardAppointmentCandidates,
  rollforwardEngagementCandidates,
} from '@vibe/db/schema';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { buildAppointmentCandidates } from '../rollforward/appointments';
import { commitRollforwardBatch, createRollforwardBatch } from '../rollforward/service';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('rollforward commit (end-to-end)', () => {
  it('creates target engagement + drop-off + appointment, then is idempotent', async () => {
    await harness.db
      .update(engagements)
      .set({
        returnType: '1040',
        dueDate: '2025-04-01',
        taxYear: 2024,
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
      reminderDaysBefore: 3,
    });
    const [srcAppt] = await harness.db
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
      .values({ appointmentId: srcAppt!.id, staffId: seed.appUserId });

    // Preview engagements + approve.
    const { batchId } = await createRollforwardBatch(harness.db, {
      firmId: seed.firmId,
      staffId: seed.appUserId,
      sourceStart: '2025-02-01',
      sourceEnd: '2025-04-15',
      targetYear: 2026,
      mode: 'DEADLINE',
      createdByAppUserId: seed.appUserId,
    });
    await harness.db
      .update(rollforwardEngagementCandidates)
      .set({ status: 'APPROVED' })
      .where(eq(rollforwardEngagementCandidates.batchId, batchId));

    // Preview appointments + approve.
    await buildAppointmentCandidates(harness.db, {
      batchId,
      firmId: seed.firmId,
      targetYear: 2026,
      mode: 'DEADLINE',
    });
    await harness.db
      .update(rollforwardAppointmentCandidates)
      .set({ status: 'APPROVED' })
      .where(eq(rollforwardAppointmentCandidates.batchId, batchId));

    const result = await commitRollforwardBatch(harness.db, {
      batchId,
      firmId: seed.firmId,
      actorAppUserId: seed.appUserId,
    });
    expect(result.engagementsCreated).toBe(1);
    expect(result.appointmentsCreated).toBe(1);

    // New engagement: DRAFT, renewed-from, taxYear+1, suggested due date.
    const targetEngId = result.mapping[0]!.targetEngagementId;
    const [newEng] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, targetEngId));
    expect(newEng!.workflowState).toBe('DRAFT');
    expect(newEng!.renewedFromEngagementId).toBe(seed.engagementId);
    expect(newEng!.taxYear).toBe(2025);
    expect(newEng!.dueDate!.startsWith('2026-')).toBe(true);

    // New drop-off request on the target engagement.
    const drops = await harness.db
      .select()
      .from(clientRequests)
      .where(
        and(eq(clientRequests.engagementId, targetEngId), eq(clientRequests.kind, 'DROP_OFF')),
      );
    expect(drops).toHaveLength(1);
    expect(drops[0]!.dueDate!.startsWith('2026-')).toBe(true);

    // New appointment linked to the target engagement.
    const newAppts = await harness.db
      .select()
      .from(appointments)
      .where(eq(appointments.engagementId, targetEngId));
    expect(newAppts).toHaveLength(1);

    // Idempotent re-commit.
    const again = await commitRollforwardBatch(harness.db, {
      batchId,
      firmId: seed.firmId,
      actorAppUserId: seed.appUserId,
    });
    expect(again.alreadyCommitted).toBe(true);
    const allTargets = await harness.db
      .select({ id: engagements.id })
      .from(engagements)
      .where(ne(engagements.id, seed.engagementId));
    expect(allTargets).toHaveLength(1); // no duplicate engagement
  });

  it('Q46 — appointment-only opt-in commits an engagement-less appointment when the engagement is skipped', async () => {
    await harness.db
      .update(engagements)
      .set({ returnType: '1040', dueDate: '2025-04-01', partnerId: seed.appUserId })
      .where(eq(engagements.id, seed.engagementId));
    const [srcAppt] = await harness.db
      .insert(appointments)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        engagementId: seed.engagementId,
        title: 'Consult',
        startsAt: new Date('2025-04-01T15:00:00Z'),
        endsAt: new Date('2025-04-01T16:00:00Z'),
        durationMinutes: 60,
        status: 'SCHEDULED',
      })
      .returning({ id: appointments.id });
    await harness.db
      .insert(appointmentStaff)
      .values({ appointmentId: srcAppt!.id, staffId: seed.appUserId });

    const { batchId } = await createRollforwardBatch(harness.db, {
      firmId: seed.firmId,
      staffId: seed.appUserId,
      sourceStart: '2025-02-01',
      sourceEnd: '2025-04-15',
      targetYear: 2026,
      mode: 'DEADLINE',
      createdByAppUserId: seed.appUserId,
    });
    // Skip the engagement; opt in to appointment-only.
    await harness.db
      .update(rollforwardEngagementCandidates)
      .set({ status: 'SKIPPED' })
      .where(eq(rollforwardEngagementCandidates.batchId, batchId));

    const n = await buildAppointmentCandidates(harness.db, {
      batchId,
      firmId: seed.firmId,
      targetYear: 2026,
      mode: 'DEADLINE',
      allowAppointmentOnly: true,
    });
    expect(n).toBe(1); // built despite the skipped engagement
    await harness.db
      .update(rollforwardAppointmentCandidates)
      .set({ status: 'APPROVED' })
      .where(eq(rollforwardAppointmentCandidates.batchId, batchId));

    const result = await commitRollforwardBatch(harness.db, {
      batchId,
      firmId: seed.firmId,
      actorAppUserId: seed.appUserId,
      allowAppointmentOnly: true,
    });
    expect(result.engagementsCreated).toBe(0);
    expect(result.appointmentsCreated).toBe(1);
    // The new appointment is engagement-less.
    const created = await harness.db
      .select()
      .from(appointments)
      .where(eq(appointments.title, 'Consult'));
    const target = created.find((a) => a.id !== srcAppt!.id)!;
    expect(target.engagementId).toBeNull();
  });
});
