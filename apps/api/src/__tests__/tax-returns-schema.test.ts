// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// TR-1 — Tax-return schema integration tests.
//
// Confirms the 0075 migration applies cleanly via pglite and that
// inserts/selects round-trip through Drizzle.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  buildPgliteHarness,
  expectDbReject,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import {
  taxReturns,
  taxReturnSections,
  taxReturnReleases,
  taxReturnAccessLog,
} from '@vibe/db/schema';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('TR-1 — schema migration', () => {
  it('all tax-return tables exist after migration', async () => {
    const rows = await harness.db.execute(
      sql`SELECT tablename FROM pg_tables WHERE tablename LIKE 'tax_return%' ORDER BY tablename`,
    );
    const names = (rows as unknown as { rows: { tablename: string }[] }).rows.map(
      (r) => r.tablename,
    );
    expect(names).toEqual([
      'tax_return_access_log',
      'tax_return_releases',
      'tax_return_sections',
      'tax_return_shares',
      'tax_returns',
    ]);
  });

  it('inserts a tax_return + section via Drizzle', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [r] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        engagementId: seed.engagementId,
        taxYear: 2025,
        formCode: '1120-S',
        title: '2025 S-Corp Return',
        status: 'PARSED',
      })
      .returning();
    expect(r!.taxYear).toBe(2025);

    const [s] = await harness.db
      .insert(taxReturnSections)
      .values({
        returnId: r!.id,
        ordinal: 0,
        depth: 0,
        rawTitle: 'Form 1120-S',
        normalizedTitle: 'Form 1120-S',
        kind: 'MAIN_FORM',
        formCode: '1120-S',
        startPage: 1,
        endPage: 5,
      })
      .returning();
    expect(s!.kind).toBe('MAIN_FORM');
  });

  it('CHECK constraint rejects invalid page range', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [r] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 2025,
        formCode: '1040',
        title: 'T',
      })
      .returning();
    await expectDbReject(
      harness.db.insert(taxReturnSections).values({
        returnId: r!.id,
        ordinal: 0,
        rawTitle: 'X',
        normalizedTitle: 'X',
        startPage: 5,
        endPage: 3, // bad
      }),
      /tax_return_sections_page_range/,
    );
  });

  it('CHECK constraint rejects tax_year out of range', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expectDbReject(
      harness.db.insert(taxReturns).values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 1899, // out of range
        formCode: '1040',
        title: 'T',
      }),
      /tax_returns_tax_year_range/,
    );
  });

  it('release with FULL scope rejects non-empty section_ids', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [r] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 2025,
        formCode: '1040',
        title: 'T',
      })
      .returning();
    await expectDbReject(
      harness.db.insert(taxReturnReleases).values({
        returnId: r!.id,
        releasedToClientId: seed.clientId,
        scope: 'FULL',
        sectionIds: ['00000000-0000-4000-8000-000000000001'],
        releasedByUserId: seed.appUserId,
      }),
      /tax_return_releases_scope_sections/,
    );
  });

  it('partial-unique index allows two revoked releases plus one live', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [r] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 2025,
        formCode: '1040',
        title: 'T',
      })
      .returning();

    // First release — live (revoked_at is null)
    await harness.db.insert(taxReturnReleases).values({
      returnId: r!.id,
      releasedToClientId: seed.clientId,
      scope: 'FULL',
      releasedByUserId: seed.appUserId,
    });
    // Soft-revoke it
    await harness.db.execute(
      sql`UPDATE tax_return_releases SET revoked_at = NOW() WHERE return_id = ${r!.id}`,
    );
    // Now a second live release is allowed
    await harness.db.insert(taxReturnReleases).values({
      returnId: r!.id,
      releasedToClientId: seed.clientId,
      scope: 'FULL',
      releasedByUserId: seed.appUserId,
    });

    const all = await harness.db
      .select()
      .from(taxReturnReleases)
      .where(sql`return_id = ${r!.id}`);
    expect(all.length).toBe(2);
  });

  it('access_log inserts and reads back', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [r] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 2025,
        formCode: '1040',
        title: 'T',
      })
      .returning();
    await harness.db.insert(taxReturnAccessLog).values({
      returnId: r!.id,
      actorKind: 'STAFF',
      actorRef: seed.appUserId,
      event: 'PARSED',
      metadata: { parser: 'pdfjs', sections: 5 },
    });
    const rows = await harness.db
      .select()
      .from(taxReturnAccessLog)
      .where(sql`return_id = ${r!.id}`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.event).toBe('PARSED');
    expect(rows[0]!.metadata).toEqual({ parser: 'pdfjs', sections: 5 });
  });
});
