// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0200 — recurring-engagement rollforward. When a recurrence with the
// rollforward toggles spawns the next annual period, the source engagement's
// drop-off + appointment are recreated on the new engagement (same ISO
// week/weekday), the drop-off is PENDING, and the new engagement is DRAFT.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { mapIsoWeek } from '@vibe/core/rollforward';
import {
  appointments,
  clientRequests,
  engagementRecurrences,
  engagementTemplates,
  engagements,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { spawnNextEngagement } from '../engagements/recurrence-spawn';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

async function setup(rollAppt: boolean, rollDrop: boolean) {
  const seed = await seedMinimalFirm(harness.db);
  // Source engagement: annual 2025 period, already CLOSED so the SCHEDULE
  // spawn doesn't hit the Q23 collision path.
  await harness.db
    .update(engagements)
    .set({ periodYear: 2025, status: 'CLOSED' })
    .where(eq(engagements.id, seed.engagementId));

  const [tpl] = await harness.db
    .insert(engagementTemplates)
    .values({
      firmId: seed.firmId,
      key: 'annual-1040',
      name: '1040 Individual',
      defaultFeeStructure: 'FIXED_FEE',
    })
    .returning({ id: engagementTemplates.id });

  // Source drop-off + appointment tied to the source engagement.
  await harness.db.insert(clientRequests).values({
    firmId: seed.firmId,
    engagementId: seed.engagementId,
    title: 'Tax docs drop-off',
    kind: 'DROP_OFF',
    dueDate: '2025-04-15',
    status: 'OPEN',
  });
  await harness.db.insert(appointments).values({
    firmId: seed.firmId,
    clientId: seed.clientId,
    engagementId: seed.engagementId,
    title: 'Tax review meeting',
    startsAt: new Date('2025-04-10T15:00:00Z'),
    endsAt: new Date('2025-04-10T16:00:00Z'),
    status: 'SCHEDULED',
  });

  const [rec] = await harness.db
    .insert(engagementRecurrences)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tpl!.id,
      frequency: 'ANNUAL',
      triggerMode: 'SCHEDULE',
      nextRunDate: '2026-01-15',
      lastEngagementId: seed.engagementId,
      rollforwardAppointment: rollAppt,
      rollforwardDropoff: rollDrop,
      createdById: seed.appUserId,
    })
    .returning({ id: engagementRecurrences.id });
  return { seed, recId: rec!.id };
}

describe('recurrence rollforward on spawn', () => {
  it('rolls the drop-off forward as PENDING and marks the engagement DRAFT', async () => {
    const { seed, recId } = await setup(false, true);
    const result = await spawnNextEngagement({
      db: harness.db,
      recurrenceId: recId,
      firmId: seed.firmId,
      actorAppUserId: seed.appUserId,
      now: new Date('2026-01-16T00:00:00Z'),
    });
    expect(result.kind).toBe('spawned');
    const newEngId = (result as { engagementId: string }).engagementId;

    const [newEng] = await harness.db
      .select({ ws: engagements.workflowState, year: engagements.periodYear })
      .from(engagements)
      .where(eq(engagements.id, newEngId));
    expect(newEng!.ws).toBe('DRAFT');
    expect(newEng!.year).toBe(2026);

    const [drop] = await harness.db
      .select({ status: clientRequests.status, dueDate: clientRequests.dueDate })
      .from(clientRequests)
      .where(and(eq(clientRequests.engagementId, newEngId), eq(clientRequests.kind, 'DROP_OFF')));
    expect(drop!.status).toBe('PENDING');
    expect(String(drop!.dueDate)).toBe(mapIsoWeek('2025-04-15', 2026));
  });

  it('rolls the appointment forward preserving ISO week/weekday', async () => {
    const { seed, recId } = await setup(true, false);
    const result = await spawnNextEngagement({
      db: harness.db,
      recurrenceId: recId,
      firmId: seed.firmId,
      actorAppUserId: seed.appUserId,
      now: new Date('2026-01-16T00:00:00Z'),
    });
    expect(result.kind).toBe('spawned');
    const newEngId = (result as { engagementId: string }).engagementId;

    const [appt] = await harness.db
      .select({ startsAt: appointments.startsAt, title: appointments.title })
      .from(appointments)
      .where(eq(appointments.engagementId, newEngId));
    expect(appt).toBeTruthy();
    expect(appt!.title).toBe('Tax review meeting');
    // Same ISO week + weekday, one year on (2025-04-10 Thu → 2026 wk15 Thu).
    const mappedDate = mapIsoWeek('2025-04-10', 2026);
    expect(new Date(appt!.startsAt).toISOString().slice(0, 10)).toBe(mappedDate);
  });

  it('only rolls forward appointments flagged rollforward_include', async () => {
    const { seed, recId } = await setup(true, false);
    // setup() already added one appointment (default include=true). Add a
    // second, explicitly excluded.
    await harness.db.insert(appointments).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      engagementId: seed.engagementId,
      title: 'Excluded one-off',
      startsAt: new Date('2025-05-20T15:00:00Z'),
      endsAt: new Date('2025-05-20T16:00:00Z'),
      status: 'SCHEDULED',
      rollforwardInclude: false,
    });
    const result = await spawnNextEngagement({
      db: harness.db,
      recurrenceId: recId,
      firmId: seed.firmId,
      actorAppUserId: seed.appUserId,
      now: new Date('2026-01-16T00:00:00Z'),
    });
    const newEngId = (result as { engagementId: string }).engagementId;
    const rolled = await harness.db
      .select({ title: appointments.title })
      .from(appointments)
      .where(eq(appointments.engagementId, newEngId));
    expect(rolled).toHaveLength(1);
    expect(rolled[0]!.title).toBe('Tax review meeting'); // the included one only
  });

  it('sets budgeted hours = prior logged hours and budgeted fee = labor cost ÷ labor%', async () => {
    const { seed, recId } = await setup(false, false);
    // 10h logged at $50/hr cost = $500 cost of labor on the source engagement.
    await harness.db.execute(
      sql`INSERT INTO time_entry
            (engagement_id, app_user_id, work_code_id, entry_date, hours,
             standard_rate_snapshot_cents, standard_amount_cents, cost_rate_snapshot_cents,
             in_scope_flag, description, status)
          VALUES (${seed.engagementId}, ${seed.appUserId}, ${seed.workCodeId}, '2025-04-15',
                  '10.00', 20000, 200000, 5000, false, 'work', 'SUBMITTED')`,
    );
    const result = await spawnNextEngagement({
      db: harness.db,
      recurrenceId: recId,
      firmId: seed.firmId,
      actorAppUserId: seed.appUserId,
      now: new Date('2026-01-16T00:00:00Z'),
    });
    const newEngId = (result as { engagementId: string }).engagementId;
    const [eng] = await harness.db
      .select({ hours: engagements.budgetHours, amt: engagements.budgetAmountCents })
      .from(engagements)
      .where(eq(engagements.id, newEngId));
    // No firm_settings row → labor% defaults to 40. $500 / 0.40 = $1,250.
    expect(Number(eng!.hours)).toBe(10);
    expect(eng!.amt).toBe(125000);
  });

  it('does not roll anything forward when toggles are off', async () => {
    const { seed, recId } = await setup(false, false);
    const result = await spawnNextEngagement({
      db: harness.db,
      recurrenceId: recId,
      firmId: seed.firmId,
      actorAppUserId: seed.appUserId,
      now: new Date('2026-01-16T00:00:00Z'),
    });
    expect(result.kind).toBe('spawned');
    const newEngId = (result as { engagementId: string }).engagementId;

    const drops = await harness.db
      .select({ id: clientRequests.id })
      .from(clientRequests)
      .where(eq(clientRequests.engagementId, newEngId));
    expect(drops).toHaveLength(0);
    const appts = await harness.db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.engagementId, newEngId));
    expect(appts).toHaveLength(0);
    // Not a rollforward spawn → keeps the default workflow state, not DRAFT.
    const [newEng] = await harness.db
      .select({ ws: engagements.workflowState })
      .from(engagements)
      .where(eq(engagements.id, newEngId));
    expect(newEng!.ws).not.toBe('DRAFT');
  });
});
