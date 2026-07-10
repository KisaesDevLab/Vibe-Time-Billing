// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// FMv2 §2 — schema integration tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';

import {
  buildPgliteHarness,
  expectDbReject,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { folderLinkAttempts, folderSyncEvents } from '@vibe/db/schema';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('FMv2 — folder_link_attempts schema', () => {
  it('table exists after migration with expected columns', async () => {
    const rows = await harness.db.execute(
      sql`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'folder_link_attempts'
          ORDER BY ordinal_position`,
    );
    const names = (rows as unknown as { rows: { column_name: string }[] }).rows.map(
      (r) => r.column_name,
    );
    expect(names).toEqual([
      'id',
      'firm_id',
      'client_id',
      'storage_path',
      'attempted_by',
      'attempted_at',
      'match_confidence',
      'match_reason_code',
      'outcome',
      'resolved_at',
      'resolved_by',
      'resolution_reason',
      'notes',
    ]);
  });

  it('inserts a row via Drizzle', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [row] = await harness.db
      .insert(folderLinkAttempts)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        storagePath: '0042 - Smith, John/',
        attemptedBy: seed.appUserId,
        matchConfidence: '0.950',
        matchReasonCode: 'exact_name_match',
        outcome: 'linked',
      })
      .returning();
    expect(row!.storagePath).toBe('0042 - Smith, John/');
    expect(row!.outcome).toBe('linked');
  });

  it('outcome CHECK rejects bogus values', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expectDbReject(
      harness.db.insert(folderLinkAttempts).values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        storagePath: 'X/',
        attemptedBy: seed.appUserId,
        outcome: 'BOGUS',
      }),
      /folder_link_attempts_outcome_chk/,
    );
  });

  it('confidence CHECK rejects > 1', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expectDbReject(
      harness.db.insert(folderLinkAttempts).values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        storagePath: 'X/',
        attemptedBy: seed.appUserId,
        matchConfidence: '1.500',
      }),
      /folder_link_attempts_confidence_range/,
    );
  });

  it('expanded event_type CHECK accepts link_* values', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // Should not throw.
    await harness.db.insert(folderSyncEvents).values({
      firmId: seed.firmId,
      eventType: 'link_attempted',
      pathAfter: 'Smith, John/',
    });
    await harness.db.insert(folderSyncEvents).values({
      firmId: seed.firmId,
      eventType: 'link_contested',
      pathAfter: 'Smith Family/',
    });
    await harness.db.insert(folderSyncEvents).values({
      firmId: seed.firmId,
      eventType: 'link_reassigned',
      pathAfter: 'Smith, John/',
    });
    const all = await harness.db
      .select()
      .from(folderSyncEvents)
      .where(eq(folderSyncEvents.firmId, seed.firmId));
    expect(all.length).toBe(3);
  });

  it('expanded event_type CHECK rejects bogus values', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await expectDbReject(
      harness.db.insert(folderSyncEvents).values({
        firmId: seed.firmId,
        eventType: 'bogus_event',
      }),
      /folder_sync_events_event_chk/,
    );
  });

  it('partial-unique indexes — multiple open attempts allowed per firm', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.insert(folderLinkAttempts).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      storagePath: 'a/',
      attemptedBy: seed.appUserId,
      outcome: 'pending',
    });
    await harness.db.insert(folderLinkAttempts).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      storagePath: 'b/',
      attemptedBy: seed.appUserId,
      outcome: 'contested',
    });
    const rows = await harness.db
      .select()
      .from(folderLinkAttempts)
      .where(eq(folderLinkAttempts.firmId, seed.firmId));
    expect(rows.length).toBe(2);
  });
});
