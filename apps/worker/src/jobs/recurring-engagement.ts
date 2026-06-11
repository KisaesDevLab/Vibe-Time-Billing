// SPDX-License-Identifier: Elastic-2.0
//
// Recurring-engagement worker (Q23). Daily sweep that fires the
// engagement_recurrence schedule + completion paths and spawns the
// next engagement via spawnNextEngagement().
//
// Two passes:
//   1. SCHEDULE — rows with status='ACTIVE', trigger_mode='SCHEDULE',
//      next_run_date <= today. spawnNextEngagement bumps next_run_date
//      via nextRunDate() on success; on collision it queues an
//      ENGAGEMENT_RENEWAL approval and leaves next_run_date alone so
//      the partner has time to act before we re-fire tomorrow.
//   2. COMPLETION — rows with status='ACTIVE',
//      trigger_mode='ON_COMPLETION', last_engagement_id closed since
//      last_run_at. No collision check needed (by definition the
//      previous one is closed).
//
// Both passes share spawnNextEngagement so the collision semantics +
// audit emits + period math are identical to the router /run-now path.

import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { engagementRecurrences, engagements } from '@vibe/db/schema';

import { spawnNextEngagement } from '../../../api/src/engagements/recurrence-spawn';

export interface RecurringEngagementResult {
  scanned: number;
  spawned: number;
  queuedForApproval: number;
  skipped: number;
  errors: number;
}

export async function runRecurringEngagementTick(
  db: Database,
  log: Logger,
  now = new Date(),
): Promise<RecurringEngagementResult> {
  const result: RecurringEngagementResult = {
    scanned: 0,
    spawned: 0,
    queuedForApproval: 0,
    skipped: 0,
    errors: 0,
  };
  const today = now.toISOString().slice(0, 10);

  // ----- Pass 1: SCHEDULE ----------------------------------------------
  const scheduled = await db
    .select({
      id: engagementRecurrences.id,
      firmId: engagementRecurrences.firmId,
      createdById: engagementRecurrences.createdById,
    })
    .from(engagementRecurrences)
    .where(
      and(
        eq(engagementRecurrences.status, 'ACTIVE'),
        eq(engagementRecurrences.triggerMode, 'SCHEDULE'),
        isNotNull(engagementRecurrences.nextRunDate),
        lte(engagementRecurrences.nextRunDate, today),
      ),
    )
    .limit(500);
  for (const rec of scheduled) {
    result.scanned += 1;
    await runOne(db, log, rec, now, result);
  }

  // ----- Pass 2: ON_COMPLETION -----------------------------------------
  // Rows where the previous engagement is closed AND we haven't fired
  // since it closed. Subquery joins engagements to compare
  // closed_at > last_run_at. First-run rows (last_engagement_id IS NULL)
  // also fire immediately — there's no previous engagement to wait on.
  const completed = await db
    .select({
      id: engagementRecurrences.id,
      firmId: engagementRecurrences.firmId,
      createdById: engagementRecurrences.createdById,
    })
    .from(engagementRecurrences)
    .leftJoin(engagements, eq(engagements.id, engagementRecurrences.lastEngagementId))
    .where(
      and(
        eq(engagementRecurrences.status, 'ACTIVE'),
        eq(engagementRecurrences.triggerMode, 'ON_COMPLETION'),
        or(
          isNull(engagementRecurrences.lastEngagementId),
          and(
            eq(engagements.status, 'CLOSED'),
            // Either the recurrence has never run, or it ran before
            // the engagement closed.
            or(
              isNull(engagementRecurrences.lastRunAt),
              sql`${engagements.closedAt} > ${engagementRecurrences.lastRunAt}`,
            ),
          ),
        ),
      ),
    )
    .limit(500);
  for (const rec of completed) {
    result.scanned += 1;
    await runOne(db, log, rec, now, result);
  }

  return result;
}

async function runOne(
  db: Database,
  log: Logger,
  rec: { id: string; firmId: string; createdById: string | null },
  now: Date,
  result: RecurringEngagementResult,
): Promise<void> {
  // Use the recurrence's created_by_id as the actor. When NULL
  // (recurrence created via some import flow), fall back to a
  // synthetic system actor — but skip the row instead since
  // approvalRequests.requesterId is NOT NULL and we have no human to
  // attribute. The router blocks NULL on create today; this is
  // defensive for legacy rows.
  if (!rec.createdById) {
    log.info({ recurrenceId: rec.id }, 'recurring-engagement: skip — no actor');
    result.skipped += 1;
    return;
  }
  try {
    const r = await spawnNextEngagement({
      db,
      recurrenceId: rec.id,
      firmId: rec.firmId,
      actorAppUserId: rec.createdById,
      now,
    });
    switch (r.kind) {
      case 'spawned':
        result.spawned += 1;
        log.info(
          { recurrenceId: rec.id, engagementId: r.engagementId, name: r.name },
          'recurring-engagement: spawned',
        );
        break;
      case 'approval_queued':
        result.queuedForApproval += 1;
        log.info(
          { recurrenceId: rec.id, approvalRequestId: r.approvalRequestId },
          'recurring-engagement: queued approval (collision)',
        );
        break;
      case 'skipped':
        result.skipped += 1;
        log.info({ recurrenceId: rec.id, reason: r.reason }, 'recurring-engagement: skipped');
        break;
      case 'error':
        result.errors += 1;
        log.warn({ recurrenceId: rec.id, reason: r.reason }, 'recurring-engagement: error');
        break;
    }
  } catch (err) {
    result.errors += 1;
    log.error({ err, recurrenceId: rec.id }, 'recurring-engagement: spawn threw');
  }
}
