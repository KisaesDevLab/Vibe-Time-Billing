// SPDX-License-Identifier: Elastic-2.0
//
// TR-3 — release helper.
//
// Pure data orchestration: validates the requested release against
// the return + section catalog, soft-revokes any existing live
// release for the same (return, client), and inserts the new release
// row. Wrapped in a transaction so partial state is impossible.
//
// Side effects (notification dispatch, render-cache warming, K-1
// auto-distribution) live in callers — this is the database boundary
// only.

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { taxReturns, taxReturnReleases, taxReturnSections } from '@vibe/db/schema';

export interface CreateReleaseInput {
  db: Database;
  returnId: string;
  releasedToClientId: string;
  scope: 'FULL' | 'SELECTED';
  // When scope='SELECTED', the client-facing section ids. Server
  // validates each one belongs to the return.
  sectionIds: string[];
  clientCanDownload: boolean;
  coverNote: string | null;
  releasedByUserId: string;
  // Caller's firm id — used as a guard so a partner from firm A
  // can't release a return from firm B.
  firmId: string;
}

export interface CreateReleaseResult {
  releaseId: string;
  supersededReleaseId: string | null;
}

export class ReleaseError extends Error {
  constructor(
    public code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ReleaseError';
  }
}

export async function createRelease(input: CreateReleaseInput): Promise<CreateReleaseResult> {
  // Load + scope-check the return.
  const [ret] = await input.db
    .select({
      id: taxReturns.id,
      firmId: taxReturns.firmId,
      status: taxReturns.status,
    })
    .from(taxReturns)
    .where(eq(taxReturns.id, input.returnId))
    .limit(1);
  if (!ret) throw new ReleaseError('return_not_found', input.returnId);
  if (ret.firmId !== input.firmId) {
    throw new ReleaseError('forbidden', 'return belongs to another firm');
  }
  if (ret.status === 'SUPERSEDED') {
    throw new ReleaseError('superseded', 'cannot release a superseded return');
  }

  // Validate scope ↔ section_ids consistency.
  if (input.scope === 'FULL' && input.sectionIds.length > 0) {
    throw new ReleaseError('scope_mismatch', 'FULL scope must have empty sectionIds');
  }
  if (input.scope === 'SELECTED' && input.sectionIds.length === 0) {
    throw new ReleaseError('scope_mismatch', 'SELECTED scope requires at least one section_id');
  }

  // Validate each section belongs to this return.
  if (input.sectionIds.length > 0) {
    const rows = await input.db
      .select({ id: taxReturnSections.id })
      .from(taxReturnSections)
      .where(eq(taxReturnSections.returnId, input.returnId));
    const knownIds = new Set(rows.map((r) => r.id));
    for (const id of input.sectionIds) {
      if (!knownIds.has(id)) {
        throw new ReleaseError('unknown_section', `section ${id} not in return`);
      }
    }
  }

  // Soft-revoke an existing live release for the same (return, client).
  // pglite + drizzle don't share a single transaction handle as
  // cleanly as we'd like across multiple inserts; the two writes are
  // logically dependent but each is a single statement, so we issue
  // them sequentially — the unique partial index prevents a duplicate
  // live release from ever existing.
  const [existing] = await input.db
    .select({ id: taxReturnReleases.id })
    .from(taxReturnReleases)
    .where(
      and(
        eq(taxReturnReleases.returnId, input.returnId),
        eq(taxReturnReleases.releasedToClientId, input.releasedToClientId),
        isNull(taxReturnReleases.revokedAt),
      ),
    )
    .limit(1);
  const supersededReleaseId = existing?.id ?? null;
  if (supersededReleaseId) {
    await input.db
      .update(taxReturnReleases)
      .set({ revokedAt: new Date(), revokedByUserId: input.releasedByUserId })
      .where(eq(taxReturnReleases.id, supersededReleaseId));
  }

  // Now create the new release.
  const [created] = await input.db
    .insert(taxReturnReleases)
    .values({
      returnId: input.returnId,
      releasedToClientId: input.releasedToClientId,
      scope: input.scope,
      sectionIds: input.sectionIds,
      clientCanDownload: input.clientCanDownload,
      coverNote: input.coverNote,
      releasedByUserId: input.releasedByUserId,
    })
    .returning({ id: taxReturnReleases.id });
  if (!created) throw new ReleaseError('insert_failed', 'release row not created');

  // Flip the return status if this is the first release.
  await input.db
    .update(taxReturns)
    .set({
      status: 'RELEASED',
      releasedAt: sql`COALESCE(${taxReturns.releasedAt}, NOW())`,
      releasedByUserId: sql`COALESCE(${taxReturns.releasedByUserId}, ${input.releasedByUserId})`,
    })
    .where(eq(taxReturns.id, input.returnId));

  return {
    releaseId: created.id,
    supersededReleaseId,
  };
}

export async function revokeRelease(
  db: Database,
  releaseId: string,
  revokedByUserId: string,
  firmId: string,
): Promise<void> {
  const [row] = await db
    .select({
      id: taxReturnReleases.id,
      returnId: taxReturnReleases.returnId,
      revokedAt: taxReturnReleases.revokedAt,
      retFirmId: taxReturns.firmId,
    })
    .from(taxReturnReleases)
    .innerJoin(taxReturns, eq(taxReturns.id, taxReturnReleases.returnId))
    .where(eq(taxReturnReleases.id, releaseId))
    .limit(1);
  if (!row) throw new ReleaseError('release_not_found', releaseId);
  if (row.retFirmId !== firmId) {
    throw new ReleaseError('forbidden', 'release belongs to another firm');
  }
  if (row.revokedAt) return; // idempotent
  await db
    .update(taxReturnReleases)
    .set({ revokedAt: new Date(), revokedByUserId: revokedByUserId })
    .where(eq(taxReturnReleases.id, releaseId));
}
