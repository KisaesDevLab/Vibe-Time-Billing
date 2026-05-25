// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R5 — Time-entry auto-split (D1).
//
// applyTimeEntryToRetainer is called from inside the time-entry create
// transaction. Uses SELECT ... FOR UPDATE on the retainer row so two
// concurrent inserts against the same retainer serialize and cannot
// over-consume the remaining hours.
//
// Returns the computed split + the new ledger row, but does NOT write
// to time_entry — the caller already has the entry in flight and
// updates retainer_id / retainer_hours / billable_hours itself.
//
// Eligibility chain (returns 100% billable WIP on any miss):
//   1. Engagement has an active retainer
//   2. retainer.status === 'active'  (D22 + status)
//   3. entryDate ≤ retainer.expiry_date  (D22)
//   4. workCodeId IS IN retainer_eligible_service set
//
// Race-safety contract: caller MUST run this inside a transaction.

import { eq, sql as drz } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { engagements, retainerEligibleServices, retainerLedger, retainers } from '@vibe/db/schema';
import { computeSplit, isEligibleEntry } from '@vibe/core/retainers';

import { logger } from '../logger';

export interface ApplyTimeEntryInput {
  engagementId: string;
  entryDate: string; // ISO YYYY-MM-DD
  hours: number;
  workCodeId: string | null;
  actorAppUserId?: string | null;
}

export interface ApplyTimeEntryResult {
  retainerId: string | null;
  retainerHours: number;
  billableHours: number;
  /** True iff this entry tipped the retainer from active → exhausted. */
  exhausted: boolean;
  /** Reason for billable-only routing, if applicable. */
  reason: 'no_retainer' | 'inactive' | 'expired' | 'wrong_code' | null;
}

type TxOrDb = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Decide the split + (when applicable) write the ledger row. Does
 * NOT insert the time_entry — caller owns that step.
 *
 * Returns retainerId=null with reason when routed entirely to WIP.
 * Caller is responsible for the time_entry insert / update; it
 * should set retainer_id, retainer_hours, billable_hours from this
 * result. The ledger row is written here (it needs to be inside the
 * same tx as the retainer.hours_consumed update for atomicity).
 *
 * @param timeEntryId — the new time_entry id. Pass null when caller
 *   hasn't inserted yet; this function will defer the ledger write.
 *   When non-null, the ledger row is written with this time_entry_id.
 */
export async function applyTimeEntryToRetainer(
  tx: TxOrDb,
  args: ApplyTimeEntryInput & { timeEntryId?: string | null },
): Promise<ApplyTimeEntryResult> {
  if (args.hours <= 0) {
    return {
      retainerId: null,
      retainerHours: 0,
      billableHours: args.hours,
      exhausted: false,
      reason: 'no_retainer',
    };
  }

  // Resolve engagement → retainer_id (the UNIQUE constraint guarantees
  // one retainer per engagement, so we don't need a separate join).
  const [eng] = await tx
    .select({ retainerId: engagements.retainerId })
    .from(engagements)
    .where(eq(engagements.id, args.engagementId))
    .limit(1);
  if (!eng?.retainerId) {
    return {
      retainerId: null,
      retainerHours: 0,
      billableHours: args.hours,
      exhausted: false,
      reason: 'no_retainer',
    };
  }

  // Lock the retainer row. Two concurrent time-entry inserts against
  // the same retainer will serialize here — the second tx sees the
  // updated hours_consumed before deciding its split.
  const lockResult = await tx.execute(
    drz`SELECT id, status, expiry_date, hours_purchased::text AS hours_purchased,
               hours_consumed::text AS hours_consumed
        FROM ${retainers}
        WHERE id = ${eng.retainerId}
        FOR UPDATE`,
  );
  const retainerRow = unwrapRow<{
    id: string;
    status: 'active' | 'exhausted' | 'expired' | 'void' | 'paused';
    expiry_date: string;
    hours_purchased: string;
    hours_consumed: string;
  }>(lockResult);
  if (!retainerRow) {
    return {
      retainerId: null,
      retainerHours: 0,
      billableHours: args.hours,
      exhausted: false,
      reason: 'no_retainer',
    };
  }

  // Eligibility set snapshot (immutable).
  const eligibility = await tx
    .select({ workCodeId: retainerEligibleServices.workCodeId })
    .from(retainerEligibleServices)
    .where(eq(retainerEligibleServices.retainerId, retainerRow.id));
  const eligibleIds = eligibility.map((e) => e.workCodeId);

  const elig = isEligibleEntry({
    retainer: {
      status: retainerRow.status,
      expiryDate:
        typeof retainerRow.expiry_date === 'string'
          ? retainerRow.expiry_date
          : new Date(retainerRow.expiry_date).toISOString().slice(0, 10),
    },
    entryDate: args.entryDate,
    workCodeId: args.workCodeId,
    eligibleWorkCodeIds: eligibleIds,
  });
  if (!elig.ok) {
    return {
      retainerId: null,
      retainerHours: 0,
      billableHours: args.hours,
      exhausted: false,
      reason: elig.reason,
    };
  }

  // Pure split math.
  const split = computeSplit({
    entryHours: args.hours,
    hoursPurchased: Number(retainerRow.hours_purchased),
    hoursConsumed: Number(retainerRow.hours_consumed),
  });
  if (split.applied === 0) {
    // Retainer is already exhausted — route entry to WIP. Defensive
    // (we should have caught this in the eligibility check too).
    return {
      retainerId: null,
      retainerHours: 0,
      billableHours: args.hours,
      exhausted: false,
      reason: 'inactive',
    };
  }

  // Update retainer hours_consumed + flip to exhausted when applicable.
  const newConsumed = Number(retainerRow.hours_consumed) + split.applied;
  const balanceAfter = Number(retainerRow.hours_purchased) - newConsumed;
  const newStatus = split.willExhaust ? 'exhausted' : retainerRow.status;
  await tx
    .update(retainers)
    .set({
      hoursConsumed: String(newConsumed),
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(eq(retainers.id, retainerRow.id));

  // Ledger row.
  if (args.timeEntryId) {
    await tx.insert(retainerLedger).values({
      retainerId: retainerRow.id,
      timeEntryId: args.timeEntryId,
      kind: 'CONSUME',
      hoursDelta: String(split.applied),
      hoursBalanceAfter: String(balanceAfter),
      createdById: args.actorAppUserId ?? null,
    });
  }
  if (split.willExhaust) {
    logger.info(
      { retainerId: retainerRow.id, engagementId: args.engagementId },
      'retainer exhausted',
    );
  }
  return {
    retainerId: retainerRow.id,
    retainerHours: split.applied,
    billableHours: split.spillover,
    exhausted: split.willExhaust,
    reason: null,
  };
}

function unwrapRow<T>(raw: unknown): T | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return (raw[0] as T) ?? null;
  if (typeof raw === 'object' && raw !== null && 'rows' in raw) {
    const rows = (raw as { rows?: T[] }).rows ?? [];
    return rows[0] ?? null;
  }
  return raw as T;
}
