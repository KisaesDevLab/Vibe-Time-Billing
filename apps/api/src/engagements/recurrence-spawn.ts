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

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appointmentStaff,
  appointments,
  approvalRequests,
  clientRequests,
  clients,
  engagementRecurrences,
  engagementTemplates,
  engagements,
  firmSettings,
  offices,
  timeEntries,
} from '@vibe/db/schema';
import { advancePeriod, resolveEngagementName, type Period } from '@vibe/core/engagements';
import { nextRunDate } from '@vibe/core/billing';
import { mapDateTime, mapIsoWeek } from '@vibe/core/rollforward';

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
  /**
   * Q23 — when the partner approves an ENGAGEMENT_RENEWAL collision request
   * ("create new, leave old open"), the approval handler re-runs the spawn
   * with this set so the collision check is bypassed and the engagement is
   * actually created.
   */
  forceCollision?: boolean;
}

/**
 * Roll the source engagement's appointment(s) and/or drop-off(s) forward onto
 * the freshly spawned engagement, preserving the ISO week-of-year + weekday
 * (annual cadence). Rolled-forward drop-offs start PENDING (hidden until the
 * worker opens them ~14 days before the new due date); appointments start
 * SCHEDULED with their staff carried over. Runs inside the spawn transaction.
 */
async function rollForwardExtras(
  tx: TxOrDb,
  opts: {
    firmId: string;
    sourceEngagementId: string;
    targetEngagementId: string;
    yearsDelta: number;
    zone: string;
    actorAppUserId: string;
    rollAppointment: boolean;
    rollDropoff: boolean;
  },
): Promise<void> {
  if (opts.rollDropoff) {
    const drops = await tx
      .select()
      .from(clientRequests)
      .where(
        and(
          eq(clientRequests.engagementId, opts.sourceEngagementId),
          eq(clientRequests.kind, 'DROP_OFF'),
          ne(clientRequests.status, 'DISMISSED'),
        ),
      );
    for (const d of drops) {
      if (!d.dueDate) continue;
      const srcDue = String(d.dueDate);
      const srcYear = Number(srcDue.slice(0, 4));
      const newDue = mapIsoWeek(srcDue, srcYear + opts.yearsDelta);
      const dueMs = Date.parse(`${newDue}T00:00:00Z`);
      const activationDate = Number.isFinite(dueMs)
        ? new Date(dueMs - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10)
        : newDue;
      await tx.insert(clientRequests).values({
        firmId: opts.firmId,
        engagementId: opts.targetEngagementId,
        title: d.title,
        kind: 'DROP_OFF',
        dueDate: newDue,
        reminderDaysBefore: d.reminderDaysBefore ?? null,
        reminderSchedule: d.reminderSchedule ?? null,
        // Carry the prior year's assignee forward.
        assignedAppUserId: d.assignedAppUserId ?? null,
        status: 'PENDING',
        activationDate,
      });
    }
  }

  if (opts.rollAppointment) {
    const appts = await tx
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.engagementId, opts.sourceEngagementId),
          eq(appointments.status, 'SCHEDULED'),
          // Only appointments explicitly flagged for rollforward (default true).
          eq(appointments.rollforwardInclude, true),
        ),
      );
    for (const a of appts) {
      const srcStart = a.startsAt instanceof Date ? a.startsAt : new Date(a.startsAt);
      const srcEnd = a.endsAt instanceof Date ? a.endsAt : new Date(a.endsAt);
      const srcYear = srcStart.getUTCFullYear();
      const newStartISO = mapDateTime({
        sourceUtcISO: srcStart.toISOString(),
        returnType: null,
        targetYear: srcYear + opts.yearsDelta,
        mode: 'ISO_WEEK',
        zone: opts.zone,
      });
      const newStart = new Date(newStartISO);
      const newEnd = new Date(newStart.getTime() + (srcEnd.getTime() - srcStart.getTime()));
      const [newAppt] = await tx
        .insert(appointments)
        .values({
          firmId: opts.firmId,
          clientId: a.clientId,
          engagementId: opts.targetEngagementId,
          title: a.title,
          description: a.description ?? null,
          startsAt: newStart,
          endsAt: newEnd,
          durationMinutes: a.durationMinutes ?? null,
          location: a.location,
          locationOptionId: a.locationOptionId ?? null,
          locationDetail: a.locationDetail ?? null,
          leadAppUserId: a.leadAppUserId ?? null,
          appointmentTypeId: a.appointmentTypeId ?? null,
          status: 'SCHEDULED',
          createdById: opts.actorAppUserId,
        })
        .returning({ id: appointments.id });
      const staff = await tx
        .select({ staffId: appointmentStaff.staffId })
        .from(appointmentStaff)
        .where(eq(appointmentStaff.appointmentId, a.id));
      if (staff.length && newAppt) {
        await tx
          .insert(appointmentStaff)
          .values(staff.map((s) => ({ appointmentId: newAppt.id, staffId: s.staffId })));
      }
    }
  }
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
  let prevPeriodYear: number | null = null;
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
    prevPeriodYear = prevPeriod.year;
    period = advancePeriod(prevPeriod, rec.frequency);

    // Collision check — only relevant on SCHEDULE fires. ON_COMPLETION
    // by definition means the previous one is closed.
    if (
      !args.forceCollision &&
      rec.triggerMode === 'SCHEDULE' &&
      prev &&
      (prev.status === 'ACTIVE' || prev.status === 'PAUSED')
    ) {
      // Q23 collision — queue an approval and do not spawn. requester
      // is the recurrence's actor (worker passes created_by_id;
      // run-now passes the session user). entityId points at the
      // recurrence so the approval-UI can read the recurrence row +
      // last engagement and render the three Q23 actions.
      //
      // Dedup: the collision path deliberately leaves next_run_date in the
      // past, so the daily worker re-selects this recurrence until the old
      // engagement closes. Without this guard that would insert a fresh
      // approval EVERY day. Reuse the existing PENDING approval instead.
      const [pending] = await args.db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.entityType, 'ENGAGEMENT_RENEWAL'),
            eq(approvalRequests.entityId, rec.id),
            eq(approvalRequests.status, 'PENDING'),
          ),
        )
        .limit(1);
      if (pending) {
        return { kind: 'approval_queued', approvalRequestId: pending.id, reason: 'collision' };
      }
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
    .select({ name: clients.name, partnerId: clients.partnerInChargeId })
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

  // 0200 — rollforward of appointment(s)/drop-off(s). Only meaningful when a
  // prior engagement exists AND the cadence advances the calendar year
  // (annual): we map the source dates to the same ISO week/weekday one (or
  // more) years on. When active, the spawned engagement lands in the DRAFT
  // workflow state so staff review it before it goes live.
  const yearsDelta =
    prevPeriodYear != null && period.year != null
      ? period.year - prevPeriodYear
      : rec.frequency === 'ANNUAL'
        ? 1
        : 0;
  const rollActive =
    (rec.rollforwardAppointment || rec.rollforwardDropoff) &&
    rec.lastEngagementId != null &&
    yearsDelta >= 1;
  let zone = 'America/Chicago';
  if (rollActive && rec.rollforwardAppointment) {
    const [office] = await args.db
      .select({ tz: offices.timezone })
      .from(offices)
      .where(eq(offices.firmId, args.firmId))
      .orderBy(desc(offices.isDefault))
      .limit(1);
    if (office?.tz) zone = office.tz;
  }

  // 0202 — carry the prior engagement's actuals into the new engagement's
  // budget: budgeted hours = logged hours; budgeted fee = cost of labor ÷
  // (firm's estimated labor %). Uses time captured on the source engagement
  // (all logged statuses; DRAFT/ARCHIVED excluded). No prior engagement or
  // no logged time → leave the template defaults in place.
  let budgetHoursFromPrev: string | null = null;
  let budgetAmountFromPrev: number | null = null;
  if (rec.lastEngagementId) {
    const [agg] = await args.db
      .select({
        hours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
        costCents: sql<string>`COALESCE(SUM(${timeEntries.hours} * COALESCE(${timeEntries.costRateSnapshotCents}, 0)), 0)`,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.engagementId, rec.lastEngagementId),
          inArray(timeEntries.status, ['SUBMITTED', 'LOCKED', 'BILLED', 'WRITTEN_OFF']),
        ),
      );
    const loggedHours = Number(agg?.hours ?? 0);
    const costCents = Math.round(Number(agg?.costCents ?? 0));
    if (loggedHours > 0) budgetHoursFromPrev = loggedHours.toFixed(2);
    if (costCents > 0) {
      const [cfg] = await args.db
        .select({ pct: firmSettings.estimatedLaborPct })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, args.firmId))
        .limit(1);
      const pct = cfg?.pct && cfg.pct > 0 ? cfg.pct : 40;
      budgetAmountFromPrev = Math.round((costCents * 100) / pct);
    }
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
        // 0202 — budgeted hours = prior logged hours; budgeted fee = prior
        // cost of labor ÷ estimated labor %. Fall back to template defaults.
        budgetHours: budgetHoursFromPrev ?? tpl.defaultBudgetHours ?? null,
        ...(budgetAmountFromPrev != null ? { budgetAmountCents: budgetAmountFromPrev } : {}),
        defaultRateCodeId: tpl.defaultRateCodeId ?? null,
        engagementTypeId: tpl.engagementTypeId ?? null,
        // 0170 — recurring engagements inherit the template's toggle defaults +
        // the client's owning partner, matching a fresh template-based create.
        partnerId: client.partnerId ?? null,
        mixedModeEnabled: tpl.defaultMixedModeEnabled,
        inScopeWorkCodeIds: tpl.inScopeWorkCodeIds,
        feePassthroughEnabled: tpl.defaultFeePassthroughEnabled,
        taxEnabled: tpl.defaultTaxEnabled,
        taxRateBps: tpl.defaultTaxRateBps ?? 0,
        taxLabel: tpl.defaultTaxLabel ?? 'Sales tax',
        surchargeEnabled: tpl.defaultSurchargeEnabled,
        surchargeType: tpl.defaultSurchargeType ?? 'PERCENT',
        surchargeValueBps: tpl.defaultSurchargeValueBps ?? 0,
        surchargeAmountCents: tpl.defaultSurchargeAmountCents ?? 0,
        surchargeLabel: tpl.defaultSurchargeLabel ?? null,
        periodYear: period.year ?? null,
        periodMonth: period.month ?? null,
        periodLabel: period.label ?? null,
        // 0172 — configurable spawned status: per-recurrence override, then
        // template default, then 'ACTIVE' (the historical hardcoded value).
        status: rec.spawnStatus ?? tpl.defaultRecurrenceStatus ?? 'ACTIVE',
        // 0200 — a rollforward spawn lands as DRAFT for staff review;
        // otherwise inherit the table default workflow state.
        ...(rollActive ? { workflowState: 'DRAFT' } : {}),
      })
      .returning({ id: engagements.id });
    if (!eng) throw new Error('engagement_insert_failed');

    if (rollActive && rec.lastEngagementId) {
      await rollForwardExtras(tx, {
        firmId: args.firmId,
        sourceEngagementId: rec.lastEngagementId,
        targetEngagementId: eng.id,
        yearsDelta,
        zone,
        actorAppUserId: args.actorAppUserId,
        rollAppointment: rec.rollforwardAppointment,
        rollDropoff: rec.rollforwardDropoff,
      });
    }

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
