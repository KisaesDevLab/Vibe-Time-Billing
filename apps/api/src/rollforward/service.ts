// SPDX-License-Identifier: Elastic-2.0
//
// Rollforward services. Phase 3 builds engagement candidates from prior-year
// engagements (the spine): query a staff person's engagements in a source
// window, compute the suggested next-year due date + drop-off date via the
// date engine, carry the fee (with the firm's configured rollover bump), and
// persist them as PENDING candidate rows under a new batch.

import { and, eq, gte, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clientRequests,
  clients,
  engagementAssignments,
  engagements,
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
