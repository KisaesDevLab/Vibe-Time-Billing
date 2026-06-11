// SPDX-License-Identifier: Elastic-2.0
//
// Recurrence spawn helper. Both the recurrence router's /run-now
// endpoint and the worker's daily sweep call this. Encapsulates:
//
//   1. Load recurrence + template + last engagement (firm-scoped).
//   2. Compute the next engagement's period:
//        - first run: use the recurrence's seed period
//        - subsequent: advancePeriod(last engagement's period, freq)
//   3. Resolve the engagement name (template.name_pattern or static).
//   4. Collision check: if last engagement is still ACTIVE/PAUSED on
//      a SCHEDULE fire, insert an ENGAGEMENT_RENEWAL approval_request
//      per Q23 and do NOT create. Otherwise insert the engagement,
//      update the recurrence (last_engagement_id, last_run_at,
//      next_run_date), and emit audit.
//
// Returns a discriminated result so callers can render the right
// status to the user / log line.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  approvalRequests,
  clients,
  engagementRecurrences,
  engagementTemplates,
  engagements,
} from '@vibe/db/schema';
import { advancePeriod, resolveEngagementName, type Period } from '@vibe/core/engagements';
import { nextRunDate } from '@vibe/core/billing';

import { emitAudit } from '../auth/audit';

type TxOrDb = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export type SpawnResult =
  | { kind: 'spawned'; engagementId: string; name: string }
  | { kind: 'approval_queued'; approvalRequestId: string; reason: 'collision' }
  | { kind: 'skipped'; reason: 'not_found' | 'paused' | 'cancelled' | 'cross_firm' }
  | { kind: 'error'; reason: string };

export interface SpawnArgs {
  db: Database;
  recurrenceId: string;
  firmId: string;
  /** App user attributed as the actor in audit / approval requester.
   *  Worker passes the recurrence's created_by_id; router /run-now
   *  passes the session user. */
  actorAppUserId: string;
  /** Override for tests so the spawn is deterministic. */
  now?: Date;
}

export async function spawnNextEngagement(args: SpawnArgs): Promise<SpawnResult> {
  const now = args.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const [rec] = await args.db
    .select()
    .from(engagementRecurrences)
    .where(eq(engagementRecurrences.id, args.recurrenceId))
    .limit(1);
  if (!rec) return { kind: 'skipped', reason: 'not_found' };
  if (rec.firmId !== args.firmId) return { kind: 'skipped', reason: 'cross_firm' };
  if (rec.status === 'PAUSED') return { kind: 'skipped', reason: 'paused' };
  if (rec.status === 'CANCELLED') return { kind: 'skipped', reason: 'cancelled' };

  // Compute the period for the new engagement.
  let period: Period;
  if (rec.lastEngagementId) {
    const [prev] = await args.db
      .select({
        periodYear: engagements.periodYear,
        periodMonth: engagements.periodMonth,
        periodLabel: engagements.periodLabel,
        status: engagements.status,
      })
      .from(engagements)
      .where(eq(engagements.id, rec.lastEngagementId))
      .limit(1);
    const prevPeriod: Period = {
      year: prev?.periodYear ?? rec.seedPeriodYear ?? null,
      month: prev?.periodMonth ?? rec.seedPeriodMonth ?? null,
      label: prev?.periodLabel ?? rec.seedPeriodLabel ?? null,
    };
    period = advancePeriod(prevPeriod, rec.frequency);

    // Collision check — only relevant on SCHEDULE fires. ON_COMPLETION
    // by definition means the previous one is closed.
    if (
      rec.triggerMode === 'SCHEDULE' &&
      prev &&
      (prev.status === 'ACTIVE' || prev.status === 'PAUSED')
    ) {
      // Q23 collision — queue an approval and do not spawn. requester
      // is the recurrence's actor (worker passes created_by_id;
      // run-now passes the session user). entityId points at the
      // recurrence so the approval-UI can read the recurrence row +
      // last engagement and render the three Q23 actions.
      const comments = JSON.stringify({
        reason: 'recurrence_collision',
        recurrenceId: rec.id,
        previousEngagementId: rec.lastEngagementId,
        suggestedPeriod: period,
      });
      const [appr] = await args.db
        .insert(approvalRequests)
        .values({
          entityType: 'ENGAGEMENT_RENEWAL',
          entityId: rec.id,
          requesterId: args.actorAppUserId,
          status: 'PENDING',
          comments,
        })
        .returning({ id: approvalRequests.id });
      await emitAudit(args.db, {
        action: 'CREATE',
        entityType: 'approval_request',
        entityId: appr?.id ?? null,
        actorAppUserId: args.actorAppUserId,
        after: { entityType: 'ENGAGEMENT_RENEWAL', recurrenceId: rec.id },
      }).catch(() => undefined);
      return {
        kind: 'approval_queued',
        approvalRequestId: appr!.id,
        reason: 'collision',
      };
    }
  } else {
    // First run — seed period stands as-is.
    period = {
      year: rec.seedPeriodYear ?? null,
      month: rec.seedPeriodMonth ?? null,
      label: rec.seedPeriodLabel ?? null,
    };
  }

  const [tpl] = await args.db
    .select()
    .from(engagementTemplates)
    .where(
      and(eq(engagementTemplates.id, rec.templateId), eq(engagementTemplates.firmId, args.firmId)),
    )
    .limit(1);
  if (!tpl) return { kind: 'error', reason: 'template_missing' };

  const [client] = await args.db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, rec.clientId))
    .limit(1);
  if (!client) return { kind: 'error', reason: 'client_missing' };

  // Resolve name: pattern → static fallback.
  let resolvedName = tpl.name;
  if (tpl.namePattern) {
    const r = resolveEngagementName(tpl.namePattern, {
      client: { name: client.name },
      period,
      today,
    });
    if (r.output.trim().length > 0) resolvedName = r.output.trim();
  }

  // Insert the new engagement + bump the recurrence in a single tx so
  // a crash between them doesn't leave the recurrence pointing at an
  // engagement that never landed (or vice versa).
  const result = await args.db.transaction(async (tx: TxOrDb) => {
    const [eng] = await tx
      .insert(engagements)
      .values({
        clientId: rec.clientId,
        name: resolvedName,
        feeStructure: tpl.defaultFeeStructure,
        feeAmountCents: tpl.defaultFeeAmountCents ?? null,
        budgetHours: tpl.defaultBudgetHours ?? null,
        defaultRateCodeId: tpl.defaultRateCodeId ?? null,
        periodYear: period.year ?? null,
        periodMonth: period.month ?? null,
        periodLabel: period.label ?? null,
        status: 'ACTIVE',
      })
      .returning({ id: engagements.id });
    if (!eng) throw new Error('engagement_insert_failed');

    const newNextRun =
      rec.triggerMode === 'SCHEDULE' && rec.nextRunDate
        ? nextRunDate(
            typeof rec.nextRunDate === 'string'
              ? rec.nextRunDate
              : new Date(rec.nextRunDate).toISOString().slice(0, 10),
            rec.frequency,
          )
        : null;

    await tx
      .update(engagementRecurrences)
      .set({
        lastEngagementId: eng.id,
        lastRunAt: now,
        nextRunDate: newNextRun,
        updatedAt: now,
      })
      .where(eq(engagementRecurrences.id, rec.id));
    return { engagementId: eng.id };
  });

  await emitAudit(args.db, {
    action: 'CREATE',
    entityType: 'engagement',
    entityId: result.engagementId,
    actorAppUserId: args.actorAppUserId,
    after: {
      spawnedByRecurrenceId: rec.id,
      period,
      name: resolvedName,
    },
  }).catch(() => undefined);

  return { kind: 'spawned', engagementId: result.engagementId, name: resolvedName };
}
