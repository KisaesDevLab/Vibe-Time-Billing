// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// TR-10 — Amend tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { taxReturnSections, taxReturns } from '@vibe/db/schema';
import {
  AmendError,
  computeAmendDiff,
  createAmendedReturn,
  markOriginalSuperseded,
} from '../tax-returns/amend';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function seedOriginal(): Promise<{
  firmId: string;
  appUserId: string;
  returnId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const [r] = await harness.db
    .insert(taxReturns)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      taxYear: 2024,
      formCode: '1040',
      title: '2024 1040',
      status: 'RELEASED',
      totalPages: 17,
    })
    .returning();
  // Two sections on the original.
  await harness.db.insert(taxReturnSections).values([
    {
      returnId: r!.id,
      ordinal: 0,
      rawTitle: 'Form 1040',
      normalizedTitle: 'Form 1040',
      kind: 'MAIN_FORM',
      formCode: '1040',
      startPage: 1,
      endPage: 5,
    },
    {
      returnId: r!.id,
      ordinal: 1,
      rawTitle: 'Schedule A',
      normalizedTitle: 'Schedule A',
      kind: 'SCHEDULE',
      formCode: 'Schedule A',
      startPage: 6,
      endPage: 8,
    },
  ]);
  return { firmId: seed.firmId, appUserId: seed.appUserId, returnId: r!.id };
}

describe('TR-10 — createAmendedReturn', () => {
  it('clones key fields with release_kind=AMENDED + amends_return_id', async () => {
    const f = await seedOriginal();
    const { amendedReturnId } = await createAmendedReturn({
      db: harness.db,
      originalReturnId: f.returnId,
      firmId: f.firmId,
      staffUserId: f.appUserId,
      newTitle: '2024 1040 (Amended)',
      newSourceFileId: null,
      newSourceFileSha256: null,
      newTotalPages: 18,
    });
    const [amended] = await harness.db
      .select()
      .from(taxReturns)
      .where(eq(taxReturns.id, amendedReturnId));
    expect(amended!.releaseKind).toBe('AMENDED');
    expect(amended!.amendsReturnId).toBe(f.returnId);
    expect(amended!.taxYear).toBe(2024);
    expect(amended!.title).toBe('2024 1040 (Amended)');
    expect(amended!.status).toBe('DRAFT');
  });

  it('rejects cross-firm', async () => {
    const f = await seedOriginal();
    await expect(
      createAmendedReturn({
        db: harness.db,
        originalReturnId: f.returnId,
        firmId: '00000000-0000-4000-8000-000000000000',
        staffUserId: f.appUserId,
        newTitle: 'X',
        newSourceFileId: null,
        newSourceFileSha256: null,
        newTotalPages: null,
      }),
    ).rejects.toThrow(/forbidden/);
  });

  it('rejects amend of an already-superseded return', async () => {
    const f = await seedOriginal();
    await harness.db
      .update(taxReturns)
      .set({ status: 'SUPERSEDED' })
      .where(eq(taxReturns.id, f.returnId));
    await expect(
      createAmendedReturn({
        db: harness.db,
        originalReturnId: f.returnId,
        firmId: f.firmId,
        staffUserId: f.appUserId,
        newTitle: 'X',
        newSourceFileId: null,
        newSourceFileSha256: null,
        newTotalPages: null,
      }),
    ).rejects.toThrow(AmendError);
  });
});

describe('TR-10 — markOriginalSuperseded', () => {
  it('flips the original to SUPERSEDED + logs', async () => {
    const f = await seedOriginal();
    const { amendedReturnId } = await createAmendedReturn({
      db: harness.db,
      originalReturnId: f.returnId,
      firmId: f.firmId,
      staffUserId: f.appUserId,
      newTitle: 'A',
      newSourceFileId: null,
      newSourceFileSha256: null,
      newTotalPages: 18,
    });
    const result = await markOriginalSuperseded(harness.db, amendedReturnId, f.firmId, f.appUserId);
    expect(result?.supersededId).toBe(f.returnId);
    const [orig] = await harness.db.select().from(taxReturns).where(eq(taxReturns.id, f.returnId));
    expect(orig!.status).toBe('SUPERSEDED');
  });

  it('returns null for a non-amendment return', async () => {
    const f = await seedOriginal();
    const result = await markOriginalSuperseded(
      harness.db,
      f.returnId, // not an AMENDED row
      f.firmId,
      f.appUserId,
    );
    expect(result).toBeNull();
  });
});

describe('TR-10 — computeAmendDiff', () => {
  it('classifies UNCHANGED / CHANGED / ADDED / REMOVED', async () => {
    const f = await seedOriginal();
    const { amendedReturnId } = await createAmendedReturn({
      db: harness.db,
      originalReturnId: f.returnId,
      firmId: f.firmId,
      staffUserId: f.appUserId,
      newTitle: 'A',
      newSourceFileId: null,
      newSourceFileSha256: null,
      newTotalPages: 20,
    });
    // amended sections: Form 1040 unchanged (same pages), Schedule A
    // grew (CHANGED), Schedule B added.
    await harness.db.insert(taxReturnSections).values([
      {
        returnId: amendedReturnId,
        ordinal: 0,
        rawTitle: 'Form 1040',
        normalizedTitle: 'Form 1040',
        kind: 'MAIN_FORM',
        formCode: '1040',
        startPage: 1,
        endPage: 5,
      },
      {
        returnId: amendedReturnId,
        ordinal: 1,
        rawTitle: 'Schedule A',
        normalizedTitle: 'Schedule A',
        kind: 'SCHEDULE',
        formCode: 'Schedule A',
        startPage: 6,
        endPage: 10, // grew from 3 pages to 5
      },
      {
        returnId: amendedReturnId,
        ordinal: 2,
        rawTitle: 'Schedule B',
        normalizedTitle: 'Schedule B',
        kind: 'SCHEDULE',
        formCode: 'Schedule B',
        startPage: 11,
        endPage: 13,
      },
    ]);
    const diff = await computeAmendDiff(harness.db, amendedReturnId, f.firmId);
    expect(diff).not.toBeNull();
    const byTitle = Object.fromEntries(diff!.sections.map((s) => [s.normalizedTitle, s.state]));
    expect(byTitle['Form 1040']).toBe('UNCHANGED');
    expect(byTitle['Schedule A']).toBe('CHANGED');
    expect(byTitle['Schedule B']).toBe('ADDED');
  });

  it('returns null for a non-amendment', async () => {
    const f = await seedOriginal();
    const diff = await computeAmendDiff(harness.db, f.returnId, f.firmId);
    expect(diff).toBeNull();
  });
});
