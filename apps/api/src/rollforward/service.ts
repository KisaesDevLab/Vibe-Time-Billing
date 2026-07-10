// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Rollforward services. Phase 3 builds engagement candidates from prior-year
// engagements (the spine): query a staff person's engagements in a source
// window, compute the suggested next-year due date + drop-off date via the
// date engine, carry the fee (with the firm's configured rollover bump), and
// persist them as PENDING candidate rows under a new batch.

import { and, eq, gte, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appointmentStaff,
  appointments,
  clientRequests,
  clients,
  engagementAssignments,
  engagementNotes,
  engagements,
  retainers,
  rollforwardAppointmentCandidates,
  rollforwardBatches,
  rollforwardEngagementCandidates,
} from '@vibe/db/schema';
import { mapDate, type MappingMode } from '@vibe/core/rollforward';

export interface CreateBatchInput {
  firmId: string;
  staffId: string;
  sourceStart: string; // YYYY-MM-DD
  sourceEnd: string; // YYYY-MM-DD
  targetYear: number;
  mode: MappingMode;
  createdByAppUserId: string;
  engagementIds?: string[]; // optional filter
  includeInactive?: boolean; // include archived clients (default false)
}

export interface CreateBatchResult {
  batchId: string;
  engagementCount: number;
}

// Pick the prior-year engagements assigned to the staff person whose filing
// (due) date falls in the source window.
function assigneeExpr(staffId: string) {
  return or(
    eq(engagements.partnerId, staffId),
    eq(engagements.managerId, staffId),
    sql`EXISTS (SELECT 1 FROM ${engagementAssignments} ea WHERE ea.engagement_id = ${engagements.id} AND ea.app_user_id = ${staffId})`,
  );
}

export async function createRollforwardBatch(
  db: Database,
  input: CreateBatchInput,
): Promise<CreateBatchResult> {
  return db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(rollforwardBatches)
      .values({
        firmId: input.firmId,
        staffId: input.staffId,
        sourceStart: input.sourceStart,
        sourceEnd: input.sourceEnd,
        targetYear: input.targetYear,
        mappingMode: input.mode,
        createdByAppUserId: input.createdByAppUserId,
      })
      .returning({ id: rollforwardBatches.id });
    const batchId = batch!.id;

    const conds = [
      eq(clients.firmId, input.firmId),
      assigneeExpr(input.staffId),
      isNotNull(engagements.dueDate),
      gte(engagements.dueDate, input.sourceStart),
      lte(engagements.dueDate, input.sourceEnd),
      ne(engagements.status, 'ARCHIVED'),
    ];
    if (!input.includeInactive) conds.push(ne(clients.status, 'ARCHIVED'));
    if (input.engagementIds?.length) conds.push(inArray(engagements.id, input.engagementIds));

    const sources = await tx
      .select({
        id: engagements.id,
        clientId: engagements.clientId,
        clientName: clients.name,
        returnType: engagements.returnType,
        engagementTypeId: engagements.engagementTypeId,
        dueDate: engagements.dueDate,
        feeAmountCents: engagements.feeAmountCents,
        bumpPct: engagements.autoRolloverPriceIncreasePct,
      })
      .from(engagements)
      .innerJoin(clients, eq(clients.id, engagements.clientId))
      .where(and(...conds));

    if (sources.length === 0) return { batchId, engagementCount: 0 };

    // One query for the DROP_OFF drop-off dates of every source engagement.
    const dropoffs = await tx
      .select({ engagementId: clientRequests.engagementId, dueDate: clientRequests.dueDate })
      .from(clientRequests)
      .where(
        and(
          inArray(
            clientRequests.engagementId,
            sources.map((s) => s.id),
          ),
          eq(clientRequests.kind, 'DROP_OFF'),
          ne(clientRequests.status, 'DISMISSED'),
        ),
      );
    const dropoffByEng = new Map<string, string>();
    for (const d of dropoffs) {
      if (d.engagementId && d.dueDate && !dropoffByEng.has(d.engagementId)) {
        dropoffByEng.set(d.engagementId, d.dueDate);
      }
    }

    const rows = sources.map((s) => {
      const suggestedDue = s.dueDate
        ? mapDate({
            sourceDate: s.dueDate,
            returnType: s.returnType,
            targetYear: input.targetYear,
            mode: input.mode,
          })
        : null;
      const srcDropoff = dropoffByEng.get(s.id) ?? null;
      const suggestedDropoff = srcDropoff
        ? mapDate({
            sourceDate: srcDropoff,
            returnType: s.returnType,
            targetYear: input.targetYear,
            mode: input.mode,
          })
        : null;
      const pct = s.bumpPct ? Number(s.bumpPct) : 0;
      const suggestedFee =
        s.feeAmountCents != null ? Math.round(Number(s.feeAmountCents) * (1 + pct / 100)) : null;
      return {
        batchId,
        firmId: input.firmId,
        sourceEngagementId: s.id,
        clientId: s.clientId,
        clientName: s.clientName,
        returnType: s.returnType,
        engagementTypeId: s.engagementTypeId,
        sourceDueDate: s.dueDate,
        suggestedDueDate: suggestedDue,
        sourceDropoffDate: srcDropoff,
        suggestedDropoffDate: suggestedDropoff,
        sourceFeeCents: s.feeAmountCents,
        suggestedFeeCents: suggestedFee,
      };
    });

    await tx.insert(rollforwardEngagementCandidates).values(rows);
    return { batchId, engagementCount: rows.length };
  });
}

export interface CommitResult {
  engagementsCreated: number;
  appointmentsCreated: number;
  alreadyCommitted: boolean;
  mapping: Array<{ sourceEngagementId: string; targetEngagementId: string }>;
}

type ApptLocation = 'VIDEO' | 'PHONE' | 'IN_PERSON';

/**
 * Commit a batch: in one transaction create the target-year engagements (DRAFT,
 * with rolled drop-off requests) for APPROVED engagement candidates, then the
 * APPROVED appointments linked to them (cascade — an appointment needs its
 * engagement). Idempotent: a COMMITTED batch is a no-op. Writes target ids back
 * onto the candidates.
 */
export async function commitRollforwardBatch(
  db: Database,
  opts: {
    batchId: string;
    firmId: string;
    actorAppUserId: string;
    // Q46 — allow committing approved appointments whose engagement was not
    // kept (creates them engagement-less). Default: cascade hard-block.
    allowAppointmentOnly?: boolean;
  },
): Promise<CommitResult> {
  return db.transaction(async (tx) => {
    const [batch] = await tx
      .select()
      .from(rollforwardBatches)
      .where(
        and(eq(rollforwardBatches.id, opts.batchId), eq(rollforwardBatches.firmId, opts.firmId)),
      )
      .limit(1);
    if (!batch) throw new Error('batch_not_found');
    if (batch.status === 'COMMITTED') {
      return { engagementsCreated: 0, appointmentsCreated: 0, alreadyCommitted: true, mapping: [] };
    }

    const engCands = await tx
      .select()
      .from(rollforwardEngagementCandidates)
      .where(
        and(
          eq(rollforwardEngagementCandidates.batchId, opts.batchId),
          eq(rollforwardEngagementCandidates.status, 'APPROVED'),
        ),
      );

    const mapping: Array<{ sourceEngagementId: string; targetEngagementId: string }> = [];
    const targetByCandidate = new Map<string, string>();

    for (const c of engCands) {
      const [src] = await tx
        .select()
        .from(engagements)
        .where(eq(engagements.id, c.sourceEngagementId))
        .limit(1);
      if (!src) continue;
      const [created] = await tx
        .insert(engagements)
        .values({
          clientId: src.clientId,
          engagementTypeId: src.engagementTypeId,
          name: src.name,
          feeStructure: src.feeStructure,
          feeAmountCents: c.suggestedFeeCents ?? src.feeAmountCents,
          budgetHours: src.budgetHours,
          budgetAmountCents: src.budgetAmountCents,
          mixedModeEnabled: src.mixedModeEnabled,
          inScopeWorkCodeIds: src.inScopeWorkCodeIds,
          nteCapCents: src.nteCapCents,
          nteCapScope: src.nteCapScope,
          feePassthroughEnabled: src.feePassthroughEnabled,
          partnerId: src.partnerId,
          managerId: src.managerId,
          scopeDefinition: src.scopeDefinition,
          status: 'PROPOSED',
          workflowState: 'DRAFT',
          returnType: src.returnType,
          taxYear: src.taxYear != null ? src.taxYear + 1 : null,
          dueDate: c.suggestedDueDate,
          autoRolloverEnabled: src.autoRolloverEnabled,
          autoRolloverPriceIncreasePct: src.autoRolloverPriceIncreasePct,
          renewedFromEngagementId: src.id,
        })
        .returning({ id: engagements.id });
      const targetId = created!.id;
      targetByCandidate.set(c.id, targetId);
      mapping.push({ sourceEngagementId: src.id, targetEngagementId: targetId });

      const assigns = await tx
        .select()
        .from(engagementAssignments)
        .where(eq(engagementAssignments.engagementId, src.id));
      if (assigns.length) {
        await tx.insert(engagementAssignments).values(
          assigns.map((a) => ({
            engagementId: targetId,
            appUserId: a.appUserId,
            role: a.role,
            assignedById: opts.actorAppUserId,
          })),
        );
      }

      if (c.suggestedDropoffDate) {
        const [srcDrop] = await tx
          .select()
          .from(clientRequests)
          .where(and(eq(clientRequests.engagementId, src.id), eq(clientRequests.kind, 'DROP_OFF')))
          .limit(1);
        // 0198 — rolled-forward drop-offs start PENDING (hidden) and the worker
        // opens + submits them 14 days before the new due date.
        const dueMs = Date.parse(`${c.suggestedDropoffDate}T00:00:00Z`);
        const activationDate = Number.isFinite(dueMs)
          ? new Date(dueMs - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10)
          : c.suggestedDropoffDate;
        await tx.insert(clientRequests).values({
          firmId: opts.firmId,
          engagementId: targetId,
          title: srcDrop?.title ?? 'Document drop-off',
          kind: 'DROP_OFF',
          dueDate: c.suggestedDropoffDate,
          reminderDaysBefore: srcDrop?.reminderDaysBefore ?? null,
          reminderSchedule: srcDrop?.reminderSchedule ?? null,
          status: 'PENDING',
          activationDate,
        });
      }

      // Q44 — carry the retainer INTENT forward. Retainers are offer-at-billing
      // and payment-gated (a draft engagement has no prep invoice to base an
      // offer on, and the prior balance forfeits on close), so we never copy a
      // funded retainer or its balance. Instead, if the source carried a live
      // retainer, leave a note so staff re-offer the same tier when this
      // engagement is billed (the offer then recurs through the normal flow).
      const [srcRetainer] = await tx
        .select({ tier: retainers.tier, hours: retainers.hoursPurchased })
        .from(retainers)
        .where(and(eq(retainers.engagementId, src.id), ne(retainers.status, 'void')))
        .limit(1);
      if (srcRetainer) {
        await tx.insert(engagementNotes).values({
          engagementId: targetId,
          authorId: opts.actorAppUserId,
          body: `Rollforward: the prior-year engagement carried a ${srcRetainer.tier} retainer (${srcRetainer.hours}h). Offer the retainer again when billing this engagement's prep fee.`,
        });
      }

      await tx
        .update(rollforwardEngagementCandidates)
        .set({ status: 'COMMITTED', targetEngagementId: targetId })
        .where(eq(rollforwardEngagementCandidates.id, c.id));
    }

    const apptCands = await tx
      .select()
      .from(rollforwardAppointmentCandidates)
      .where(
        and(
          eq(rollforwardAppointmentCandidates.batchId, opts.batchId),
          eq(rollforwardAppointmentCandidates.status, 'APPROVED'),
        ),
      );
    let appointmentsCreated = 0;
    for (const a of apptCands) {
      if (!a.suggestedStartsAt) continue;
      const targetEngId = targetByCandidate.get(a.engagementCandidateId) ?? null;
      // Cascade hard-block by default; with the opt-in, commit engagement-less.
      if (!targetEngId && !opts.allowAppointmentOnly) continue;
      const staffIds = (a.staffIds as string[]) ?? [];
      const start = a.suggestedStartsAt;
      const end = new Date(start.getTime() + a.durationMinutes * 60_000);
      const [appt] = await tx
        .insert(appointments)
        .values({
          firmId: opts.firmId,
          clientId: a.clientId,
          engagementId: targetEngId,
          title: a.title,
          startsAt: start,
          endsAt: end,
          durationMinutes: a.durationMinutes,
          location: (a.location as ApptLocation | null) ?? 'VIDEO',
          locationOptionId: a.locationOptionId,
          leadAppUserId: staffIds[0] ?? null,
          status: 'SCHEDULED',
          createdById: opts.actorAppUserId,
        })
        .returning({ id: appointments.id });
      if (staffIds.length) {
        await tx
          .insert(appointmentStaff)
          .values(staffIds.map((s) => ({ appointmentId: appt!.id, staffId: s })));
      }
      await tx
        .update(rollforwardAppointmentCandidates)
        .set({ status: 'COMMITTED', targetAppointmentId: appt!.id })
        .where(eq(rollforwardAppointmentCandidates.id, a.id));
      appointmentsCreated += 1;
    }

    await tx
      .update(rollforwardBatches)
      .set({
        status: 'COMMITTED',
        committedAt: new Date(),
        idempotencyKey: `rollforward:${opts.batchId}`,
      })
      .where(eq(rollforwardBatches.id, opts.batchId));

    return {
      engagementsCreated: mapping.length,
      appointmentsCreated,
      alreadyCommitted: false,
      mapping,
    };
  });
}
