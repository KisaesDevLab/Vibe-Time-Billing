// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0083 — recurring-engagement worker sweep.
//
// Exercises both passes (SCHEDULE + ON_COMPLETION) and the collision
// path (active previous on a SCHEDULE fire → queues approval).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  type PgliteHarness,
} from '../../../api/src/__tests__/_pglite-harness';
import {
  approvalRequests,
  engagementRecurrences,
  engagementTemplates,
  engagements,
} from '@vibe/db/schema';
import { runRecurringEngagementTick } from '../jobs/recurring-engagement';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

const silentLog = pino({ enabled: false });

async function seedTemplate(firmId: string, namePattern?: string | null): Promise<string> {
  const [row] = await harness.db
    .insert(engagementTemplates)
    .values({
      firmId,
      key: `tpl-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Monthly Bookkeeping',
      defaultFeeStructure: 'FIXED_FEE',
      namePattern: namePattern ?? 'Bookkeeping {{period.month}}/{{period.year}}',
    })
    .returning({ id: engagementTemplates.id });
  return row!.id;
}

describe('runRecurringEngagementTick — SCHEDULE pass', () => {
  it('spawns when next_run_date <= today and no previous engagement', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    await harness.db.insert(engagementRecurrences).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tplId,
      frequency: 'MONTHLY',
      triggerMode: 'SCHEDULE',
      nextRunDate: '2026-04-01',
      seedPeriodYear: 2026,
      seedPeriodMonth: 4,
      createdById: seed.appUserId,
    });
    const result = await runRecurringEngagementTick(
      harness.db,
      silentLog,
      new Date('2026-04-02T10:00:00Z'),
    );
    expect(result.spawned).toBe(1);
    expect(result.queuedForApproval).toBe(0);
    // New engagement exists.
    const engRows = await harness.db.select().from(engagements);
    const spawned = engRows.find((e) => e.name?.startsWith('Bookkeeping'));
    expect(spawned).toBeDefined();
    expect(spawned!.periodYear).toBe(2026);
    expect(spawned!.periodMonth).toBe(4);
    // Recurrence bumped.
    const [rec] = await harness.db.select().from(engagementRecurrences);
    expect(rec!.lastEngagementId).toBe(spawned!.id);
    expect(rec!.nextRunDate).toBe('2026-05-01');
  });

  it('does not spawn when next_run_date is in the future', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    await harness.db.insert(engagementRecurrences).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tplId,
      frequency: 'MONTHLY',
      triggerMode: 'SCHEDULE',
      nextRunDate: '2027-01-01',
      seedPeriodYear: 2027,
      seedPeriodMonth: 1,
      createdById: seed.appUserId,
    });
    const result = await runRecurringEngagementTick(
      harness.db,
      silentLog,
      new Date('2026-04-02T10:00:00Z'),
    );
    expect(result.scanned).toBe(0);
    expect(result.spawned).toBe(0);
  });

  it('Q23 collision: queues approval when previous engagement is still ACTIVE', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    // Seed an already-spawned engagement that's still ACTIVE.
    const [prevEng] = await harness.db
      .insert(engagements)
      .values({
        clientId: seed.clientId,
        name: 'Bookkeeping 3/2026',
        feeStructure: 'FIXED_FEE',
        status: 'ACTIVE',
        periodYear: 2026,
        periodMonth: 3,
      })
      .returning({ id: engagements.id });
    await harness.db.insert(engagementRecurrences).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tplId,
      frequency: 'MONTHLY',
      triggerMode: 'SCHEDULE',
      nextRunDate: '2026-04-01',
      lastEngagementId: prevEng!.id,
      createdById: seed.appUserId,
    });
    const result = await runRecurringEngagementTick(
      harness.db,
      silentLog,
      new Date('2026-04-02T10:00:00Z'),
    );
    expect(result.spawned).toBe(0);
    expect(result.queuedForApproval).toBe(1);
    // Approval row exists with the right entityType.
    const apprs = await harness.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.entityType, 'ENGAGEMENT_RENEWAL'));
    expect(apprs).toHaveLength(1);
    // Recurrence next_run_date NOT bumped — we re-fire on the next sweep so
    // the collision stays visible until the partner acts.
    const [rec] = await harness.db.select().from(engagementRecurrences);
    expect(rec!.nextRunDate).toBe('2026-04-01');
  });

  it('Q23 collision: re-firing does NOT pile up duplicate approvals (dedup)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    const [prevEng] = await harness.db
      .insert(engagements)
      .values({
        clientId: seed.clientId,
        name: 'Bookkeeping 3/2026',
        feeStructure: 'FIXED_FEE',
        status: 'ACTIVE',
        periodYear: 2026,
        periodMonth: 3,
      })
      .returning({ id: engagements.id });
    await harness.db.insert(engagementRecurrences).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tplId,
      frequency: 'MONTHLY',
      triggerMode: 'SCHEDULE',
      nextRunDate: '2026-04-01',
      lastEngagementId: prevEng!.id,
      createdById: seed.appUserId,
    });
    // Three daily sweeps while the previous engagement stays open.
    await runRecurringEngagementTick(harness.db, silentLog, new Date('2026-04-02T10:00:00Z'));
    await runRecurringEngagementTick(harness.db, silentLog, new Date('2026-04-03T10:00:00Z'));
    await runRecurringEngagementTick(harness.db, silentLog, new Date('2026-04-04T10:00:00Z'));
    // Exactly ONE pending approval — not one per day.
    const apprs = await harness.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.entityType, 'ENGAGEMENT_RENEWAL'));
    expect(apprs).toHaveLength(1);
  });

  it('advances period on subsequent runs based on previous engagement period', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    // Previous engagement is CLOSED — collision check passes.
    const [prevEng] = await harness.db
      .insert(engagements)
      .values({
        clientId: seed.clientId,
        name: 'Bookkeeping 3/2026',
        feeStructure: 'FIXED_FEE',
        status: 'CLOSED',
        periodYear: 2026,
        periodMonth: 3,
      })
      .returning({ id: engagements.id });
    await harness.db.insert(engagementRecurrences).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tplId,
      frequency: 'MONTHLY',
      triggerMode: 'SCHEDULE',
      nextRunDate: '2026-04-01',
      lastEngagementId: prevEng!.id,
      createdById: seed.appUserId,
    });
    const result = await runRecurringEngagementTick(
      harness.db,
      silentLog,
      new Date('2026-04-02T10:00:00Z'),
    );
    expect(result.spawned).toBe(1);
    // seedMinimalFirm pre-creates a "Test Engagement"; filter for our spawn.
    const spawned = (await harness.db.select().from(engagements)).find(
      (e) => e.name === 'Bookkeeping 4/2026',
    );
    expect(spawned).toBeDefined();
    expect(spawned!.periodMonth).toBe(4);
    expect(spawned!.periodYear).toBe(2026);
  });
});

describe('runRecurringEngagementTick — ON_COMPLETION pass', () => {
  it("spawns when previous is CLOSED and we haven't fired since", async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    const closedAt = new Date('2026-04-05T10:00:00Z');
    const [prevEng] = await harness.db
      .insert(engagements)
      .values({
        clientId: seed.clientId,
        name: 'Old book',
        feeStructure: 'FIXED_FEE',
        status: 'CLOSED',
        periodYear: 2026,
        periodMonth: 3,
      })
      .returning({ id: engagements.id });
    // Set closedAt explicitly via UPDATE (no zod path to set it on insert).
    await harness.db.execute(
      sql`UPDATE engagement SET closed_at = ${closedAt.toISOString()} WHERE id = ${prevEng!.id}`,
    );
    await harness.db.insert(engagementRecurrences).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tplId,
      frequency: 'MONTHLY',
      triggerMode: 'ON_COMPLETION',
      // lastRunAt earlier than closedAt → should fire.
      lastRunAt: new Date('2026-04-01T00:00:00Z'),
      lastEngagementId: prevEng!.id,
      createdById: seed.appUserId,
    });
    const result = await runRecurringEngagementTick(
      harness.db,
      silentLog,
      new Date('2026-04-06T10:00:00Z'),
    );
    expect(result.spawned).toBe(1);
  });

  it('does NOT spawn when previous is still ACTIVE', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    const [prevEng] = await harness.db
      .insert(engagements)
      .values({
        clientId: seed.clientId,
        name: 'Still open',
        feeStructure: 'FIXED_FEE',
        status: 'ACTIVE',
        periodYear: 2026,
        periodMonth: 3,
      })
      .returning({ id: engagements.id });
    await harness.db.insert(engagementRecurrences).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tplId,
      frequency: 'MONTHLY',
      triggerMode: 'ON_COMPLETION',
      lastEngagementId: prevEng!.id,
      createdById: seed.appUserId,
    });
    const result = await runRecurringEngagementTick(
      harness.db,
      silentLog,
      new Date('2026-04-06T10:00:00Z'),
    );
    expect(result.spawned).toBe(0);
  });

  it('first-run ON_COMPLETION (no previous) fires immediately', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    await harness.db.insert(engagementRecurrences).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tplId,
      frequency: 'MONTHLY',
      triggerMode: 'ON_COMPLETION',
      seedPeriodYear: 2026,
      seedPeriodMonth: 4,
      createdById: seed.appUserId,
    });
    const result = await runRecurringEngagementTick(
      harness.db,
      silentLog,
      new Date('2026-04-06T10:00:00Z'),
    );
    expect(result.spawned).toBe(1);
  });

  it('skips recurrences with no createdById (defensive)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    await harness.db.insert(engagementRecurrences).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tplId,
      frequency: 'MONTHLY',
      triggerMode: 'SCHEDULE',
      nextRunDate: '2026-04-01',
      // createdById omitted → null
    });
    const result = await runRecurringEngagementTick(
      harness.db,
      silentLog,
      new Date('2026-04-02T10:00:00Z'),
    );
    expect(result.spawned).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
