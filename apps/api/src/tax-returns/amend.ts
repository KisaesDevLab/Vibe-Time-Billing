// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-10 — Amended-return chain helpers.
//
// Amending a return creates a NEW tax_returns row with
// release_kind='AMENDED' + amends_return_id pointing at the original.
// When the amended return is approved (or released for the first
// time), the original is flipped to status='SUPERSEDED' but is NOT
// deleted — existing shares on the original keep working until they
// expire. New shares against superseded returns are rejected by
// share-helper (created in TR-6).
//
// Pure helpers; the route layer (a follow-up commit) wires them up
// behind engagement:write.

import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { taxReturns, taxReturnSections } from '@vibe/db/schema';
import { appendAccessLog } from './access-log';

export class AmendError extends Error {
  constructor(
    public code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'AmendError';
  }
}

export interface CreateAmendedInput {
  db: Database;
  originalReturnId: string;
  firmId: string;
  staffUserId: string;
  newTitle: string;
  newSourceFileId: string | null;
  newSourceFileSha256: string | null;
  newTotalPages: number | null;
}

export interface CreateAmendedResult {
  amendedReturnId: string;
}

export async function createAmendedReturn(input: CreateAmendedInput): Promise<CreateAmendedResult> {
  const [orig] = await input.db
    .select()
    .from(taxReturns)
    .where(eq(taxReturns.id, input.originalReturnId))
    .limit(1);
  if (!orig) throw new AmendError('original_not_found', input.originalReturnId);
  if (orig.firmId !== input.firmId) {
    throw new AmendError('forbidden', 'return belongs to another firm');
  }
  if (orig.status === 'SUPERSEDED') {
    throw new AmendError('already_superseded', 'cannot amend a superseded return');
  }
  // Copy the relevant fields onto the new row.
  const [amended] = await input.db
    .insert(taxReturns)
    .values({
      firmId: orig.firmId,
      clientId: orig.clientId,
      engagementId: orig.engagementId,
      taxYear: orig.taxYear,
      formCode: orig.formCode,
      jurisdiction: orig.jurisdiction,
      title: input.newTitle,
      status: 'DRAFT',
      releaseKind: 'AMENDED',
      amendsReturnId: input.originalReturnId,
      sourceFileId: input.newSourceFileId,
      sourceFileSha256: input.newSourceFileSha256,
      totalPages: input.newTotalPages,
    })
    .returning({ id: taxReturns.id });
  if (!amended) throw new AmendError('insert_failed', 'amended row not created');
  return { amendedReturnId: amended.id };
}

// Called when the amended return is approved/released. Flips the
// original to SUPERSEDED — existing shares on it still work until
// they expire; new shares are rejected (TR-6).
export async function markOriginalSuperseded(
  db: Database,
  amendedReturnId: string,
  firmId: string,
  staffUserId: string,
): Promise<{ supersededId: string } | null> {
  const [amended] = await db
    .select({
      id: taxReturns.id,
      firmId: taxReturns.firmId,
      amendsReturnId: taxReturns.amendsReturnId,
      releaseKind: taxReturns.releaseKind,
    })
    .from(taxReturns)
    .where(eq(taxReturns.id, amendedReturnId))
    .limit(1);
  if (!amended || amended.firmId !== firmId) {
    throw new AmendError('not_found', amendedReturnId);
  }
  if (amended.releaseKind !== 'AMENDED' || !amended.amendsReturnId) {
    return null; // not an amendment chain — nothing to supersede
  }
  await db
    .update(taxReturns)
    .set({ status: 'SUPERSEDED' })
    .where(and(eq(taxReturns.id, amended.amendsReturnId), eq(taxReturns.firmId, firmId)));
  await appendAccessLog({
    db,
    returnId: amended.amendsReturnId,
    event: 'SUPERSEDED',
    actorKind: 'STAFF',
    actorRef: staffUserId,
    metadata: { supersededBy: amendedReturnId },
  }).catch(() => undefined);
  return { supersededId: amended.amendsReturnId };
}

// =====================================================================
// What-changed diff (presence + page counts only — line items are too
// brittle, per the plan §12).
// =====================================================================

export interface SectionDiffEntry {
  normalizedTitle: string;
  formCode: string | null;
  beforePages: number | null;
  afterPages: number | null;
  // 'ADDED' / 'REMOVED' / 'CHANGED' / 'UNCHANGED'
  state: 'ADDED' | 'REMOVED' | 'CHANGED' | 'UNCHANGED';
}

export interface AmendDiff {
  before: { returnId: string; totalPages: number | null };
  after: { returnId: string; totalPages: number | null };
  sections: SectionDiffEntry[];
}

export async function computeAmendDiff(
  db: Database,
  amendedReturnId: string,
  firmId: string,
): Promise<AmendDiff | null> {
  const [amended] = await db
    .select({
      id: taxReturns.id,
      firmId: taxReturns.firmId,
      amendsReturnId: taxReturns.amendsReturnId,
      totalPages: taxReturns.totalPages,
    })
    .from(taxReturns)
    .where(eq(taxReturns.id, amendedReturnId))
    .limit(1);
  if (!amended || amended.firmId !== firmId || !amended.amendsReturnId) return null;

  const [orig] = await db
    .select({ id: taxReturns.id, totalPages: taxReturns.totalPages })
    .from(taxReturns)
    .where(eq(taxReturns.id, amended.amendsReturnId))
    .limit(1);
  if (!orig) return null;

  const [origSections, amendedSections] = await Promise.all([
    db
      .select({
        normalizedTitle: taxReturnSections.normalizedTitle,
        formCode: taxReturnSections.formCode,
        startPage: taxReturnSections.startPage,
        endPage: taxReturnSections.endPage,
      })
      .from(taxReturnSections)
      .where(eq(taxReturnSections.returnId, orig.id)),
    db
      .select({
        normalizedTitle: taxReturnSections.normalizedTitle,
        formCode: taxReturnSections.formCode,
        startPage: taxReturnSections.startPage,
        endPage: taxReturnSections.endPage,
      })
      .from(taxReturnSections)
      .where(eq(taxReturnSections.returnId, amended.id)),
  ]);

  function key(s: { normalizedTitle: string; formCode: string | null }): string {
    return s.formCode ? `${s.formCode}|${s.normalizedTitle}` : s.normalizedTitle;
  }
  function pages(s: { startPage: number; endPage: number }): number {
    return s.endPage - s.startPage + 1;
  }
  const beforeMap = new Map(origSections.map((s) => [key(s), s]));
  const afterMap = new Map(amendedSections.map((s) => [key(s), s]));
  const keys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const diff: SectionDiffEntry[] = [];
  for (const k of keys) {
    const b = beforeMap.get(k);
    const a = afterMap.get(k);
    let state: SectionDiffEntry['state'];
    if (a && !b) state = 'ADDED';
    else if (!a && b) state = 'REMOVED';
    else if (a && b && pages(a) !== pages(b)) state = 'CHANGED';
    else state = 'UNCHANGED';
    const sample = a ?? b!;
    diff.push({
      normalizedTitle: sample.normalizedTitle,
      formCode: sample.formCode,
      beforePages: b ? pages(b) : null,
      afterPages: a ? pages(a) : null,
      state,
    });
  }
  return {
    before: { returnId: orig.id, totalPages: orig.totalPages },
    after: { returnId: amended.id, totalPages: amended.totalPages },
    sections: diff,
  };
}

// Silence unused-import.
void sql;
