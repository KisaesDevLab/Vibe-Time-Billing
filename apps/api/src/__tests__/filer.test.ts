// SPDX-License-Identifier: Elastic-2.0
//
// Vibe Filer — scan/match + route + undo end-to-end (pglite + fake B2).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { pino } from 'pino';
import { and, eq, sql } from 'drizzle-orm';

import type { StorageClient } from '@vibe/storage';
import {
  clientFolders,
  files,
  inboxItems,
  inboxRoutingLog,
  inboxRoutingProfiles,
} from '@vibe/db/schema';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { scanInbox, matchObject } from '../filer/scan';
import { runFilerRoute } from '../../../worker/src/jobs/filer-route';

const log = pino({ level: 'silent' });
let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

// In-memory B2 fake exposing the methods the filer uses.
function fakeStorage(initial: string[]): { storage: StorageClient; keys: () => string[] } {
  const objs = new Map<string, { size: number; etag: string }>();
  for (const k of initial) objs.set(k, { size: 100, etag: `e${k.length}` });
  const client = {
    kind: 'mock' as const,
    async *list(prefix: string) {
      for (const [k, v] of objs) {
        if (!k.startsWith(prefix)) continue;
        yield {
          kind: 'object' as const,
          key: k,
          meta: { key: k, sizeBytes: v.size, etag: v.etag, lastModified: new Date() },
        };
      }
    },
    async head(k: string) {
      const o = objs.get(k);
      return o ? { key: k, sizeBytes: o.size, etag: o.etag, lastModified: new Date() } : null;
    },
    async delete(k: string) {
      objs.delete(k);
    },
    async copy(src: string, dest: string) {
      const s = objs.get(src);
      objs.set(dest, { size: s?.size ?? 0, etag: `c${dest.length}` });
      return { etag: `c${dest.length}` };
    },
    async put(k: string) {
      objs.set(k, { size: 0, etag: 'p' });
      return { etag: 'p' };
    },
  };
  return { storage: client as unknown as StorageClient, keys: () => Array.from(objs.keys()) };
}

async function setup(): Promise<{ firmId: string; clientId: string; appUserId: string }> {
  const seed = await seedMinimalFirm(harness.db);
  await harness.db.execute(
    sql`UPDATE client SET external_id = '123456' WHERE id = ${seed.clientId}`,
  );
  await harness.db.insert(clientFolders).values({
    firmId: seed.firmId,
    clientId: seed.clientId,
    storagePath: 'Test Client Co/',
  });
  return seed;
}

describe('matchObject (pure)', () => {
  const clientsList = [
    { id: 'c1', name: 'Acme Corp', externalId: '123456', status: 'ACTIVE' },
    { id: 'c2', name: 'Beacon LLC', externalId: '222222', status: 'INACTIVE' },
  ];
  const bound = new Set(['c1', 'c2']);

  it('id hit on external_id → matched', () => {
    const r = matchObject('Acme Corp_123456_2024.pdf', clientsList, [], bound);
    expect(r.matchStatus).toBe('matched');
    expect(r.matchedClient).toBe('c1');
  });
  it('inactive client → inactive', () => {
    const r = matchObject('Beacon LLC_222222_2024.pdf', clientsList, [], bound);
    expect(r.matchStatus).toBe('inactive');
  });
  it('name fuzzy ≥95% → fuzzy', () => {
    const r = matchObject('Acme Corp_W2.pdf', clientsList, [], bound);
    expect(r.matchStatus).toBe('fuzzy');
    expect(r.matchedClient).toBe('c1');
  });
  it('unbound folder → folder_unbound', () => {
    const r = matchObject('Acme Corp_123456_2024.pdf', clientsList, [], new Set());
    expect(r.matchStatus).toBe('folder_unbound');
  });
  it('no match → unparseable (red)', () => {
    const r = matchObject('Nobody_999999_2024.pdf', clientsList, [], bound);
    expect(r.matchStatus).toBe('unparseable');
  });

  // 0149 — external id found ANYWHERE in the filename, not just the
  // strict name_ID_rest slot.
  it('id anywhere: trailing token matches', () => {
    const r = matchObject('2024 W2 123456.pdf', clientsList, [], bound);
    expect(r.matchStatus).toBe('matched');
    expect(r.matchedClient).toBe('c1');
    expect(r.parsedId).toBe('123456');
  });
  it('id anywhere: dash-separated matches without a name-sim penalty', () => {
    const r = matchObject('Smith-123456-W2.pdf', clientsList, [], bound);
    expect(r.matchStatus).toBe('matched');
    expect(r.matchedClient).toBe('c1');
  });
  it('id anywhere: ambiguous (two clients) falls through to name match', () => {
    const r = matchObject('123456 222222 transfer.pdf', clientsList, [], bound);
    expect(r.matchedClient).toBeNull();
  });
  it('id anywhere: digits-only filename still matches', () => {
    const r = matchObject('123456.pdf', clientsList, [], bound);
    expect(r.matchStatus).toBe('matched');
    expect(r.matchedClient).toBe('c1');
  });

  // 0149 follow-up — alphanumeric external ids match anywhere too.
  const alnumClients = [
    ...clientsList,
    { id: 'c3', name: 'Allen David', externalId: 'ALLE1234', status: 'ACTIVE' },
  ];
  const alnumBound = new Set(['c1', 'c2', 'c3']);
  it('alphanumeric id matches anywhere (real-world tax export name)', () => {
    const r = matchObject(
      'David, Allen_2025_1040_GovernmentCopyTaxReturn_ALLE1234.pdf',
      alnumClients,
      [],
      alnumBound,
    );
    expect(r.matchStatus).toBe('matched');
    expect(r.matchedClient).toBe('c3');
    expect(r.parsedId).toBe('ALLE1234');
  });
  it('loose match recovers the year the strict parse consumed as id', () => {
    const rules = [
      {
        id: 'r1',
        sortOrder: 0,
        identifier: '1040',
        matchMode: 'contains' as const,
        caseSensitive: false,
        targetPath: 'Tax Returns',
        yearBehavior: 'current_only' as const,
        isTaxReturn: true,
        enabled: true,
      },
    ];
    const r = matchObject(
      'David, Allen_2025_1040_GovernmentCopyTaxReturn_ALLE1234.pdf',
      alnumClients,
      rules,
      alnumBound,
    );
    expect(r.matchStatus).toBe('matched');
    expect(r.parsedYear).toBe(2025);
    expect(r.suggestedRule).toBe('r1');
    expect(r.suggestedPath).toBe('Tax Returns/2025/');
  });

  it('alphanumeric id is case-insensitive and boundary-guarded', () => {
    expect(matchObject('alle1234 w2.pdf', alnumClients, [], alnumBound).matchedClient).toBe('c3');
    // Embedded in a longer token → no match (XALLE12345 ≠ ALLE1234).
    expect(
      matchObject('XALLE12345_notes.pdf', alnumClients, [], alnumBound).matchedClient,
    ).toBeNull();
  });
});

describe('scanInbox', () => {
  it('upserts inbox_items with match statuses', async () => {
    const f = await setup();
    const { storage } = fakeStorage([
      'Inbox/Test Client Co_123456_2024-1040.pdf',
      'Inbox/Unknownco_999999_x.pdf',
      'Inbox/.bzEmpty',
    ]);
    const res = await scanInbox(harness.db, storage, f.firmId);
    expect(res.scanned).toBe(2); // .bzEmpty skipped
    const rows = await harness.db.select().from(inboxItems).where(eq(inboxItems.firmId, f.firmId));
    expect(rows).toHaveLength(2);
    const matched = rows.find((r) => r.objectKey.includes('123456'));
    expect(matched?.matchStatus).toBe('matched');
    expect(matched?.matchedClient).toBe(f.clientId);
    const unknown = rows.find((r) => r.objectKey.includes('999999'));
    expect(unknown?.matchStatus).toBe('unparseable');
  });

  it('re-scan preserves review state but refreshes match', async () => {
    const f = await setup();
    const { storage } = fakeStorage(['Inbox/Test Client Co_123456_2024.pdf']);
    await scanInbox(harness.db, storage, f.firmId);
    await harness.db
      .update(inboxItems)
      .set({ reviewAction: 'flag_tax', flagFormCode: '1040' })
      .where(eq(inboxItems.firmId, f.firmId));
    await scanInbox(harness.db, storage, f.firmId);
    const [row] = await harness.db.select().from(inboxItems).where(eq(inboxItems.firmId, f.firmId));
    expect(row!.reviewAction).toBe('flag_tax'); // preserved
    expect(row!.matchStatus).toBe('matched'); // refreshed
  });
});

describe('route + undo', () => {
  it('routes a file into the client folder, logs, deletes the inbox original; undo restores', async () => {
    const f = await setup();
    const inboxKey = 'Inbox/Test Client Co_123456_2024-1040.pdf';
    const { storage, keys } = fakeStorage([inboxKey]);
    await scanInbox(harness.db, storage, f.firmId);
    const [item] = await harness.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.firmId, f.firmId));

    const batchId = '00000000-0000-4000-8000-0000000000aa';
    await runFilerRoute(harness.db, storage, log, {
      kind: 'route',
      firmId: f.firmId,
      actorId: f.appUserId,
      batchId,
      itemId: item!.id,
    });

    // Inbox original gone; routed copy present with id stripped.
    const live = keys();
    expect(live).not.toContain(inboxKey);
    expect(live.some((k) => k === 'Test Client Co/Test Client Co_2024-1040.pdf')).toBe(true);

    // files row + log + inbox row removed.
    const fileRows = await harness.db.select().from(files).where(eq(files.firmId, f.firmId));
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]!.source).toBe('filer');
    const [logRow] = await harness.db
      .select()
      .from(inboxRoutingLog)
      .where(eq(inboxRoutingLog.batchId, batchId));
    expect(logRow!.action).toBe('filed');
    expect(logRow!.status).toBe('success');
    const remaining = await harness.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.firmId, f.firmId));
    expect(remaining).toHaveLength(0);

    // Undo restores the inbox original + soft-deletes the file + reverses the log.
    await runFilerRoute(harness.db, storage, log, {
      kind: 'undo',
      firmId: f.firmId,
      actorId: f.appUserId,
      logId: logRow!.id,
    });
    expect(keys()).toContain(inboxKey);
    const [reversed] = await harness.db
      .select()
      .from(inboxRoutingLog)
      .where(eq(inboxRoutingLog.id, logRow!.id));
    expect(reversed!.status).toBe('reversed');
    const [softDeleted] = await harness.db
      .select()
      .from(files)
      .where(eq(files.id, fileRows[0]!.id));
    expect(softDeleted!.deletedAt).not.toBeNull();
  });

  it('skips when the source is gone (pulled in Explorer)', async () => {
    const f = await setup();
    const { storage } = fakeStorage(['Inbox/Test Client Co_123456_2024.pdf']);
    await scanInbox(harness.db, storage, f.firmId);
    const [item] = await harness.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.firmId, f.firmId));
    // Remove the object before routing.
    await storage.delete('Inbox/Test Client Co_123456_2024.pdf');
    const batchId = '00000000-0000-4000-8000-0000000000bb';
    await runFilerRoute(harness.db, storage, log, {
      kind: 'route',
      firmId: f.firmId,
      actorId: f.appUserId,
      batchId,
      itemId: item!.id,
    });
    const [logRow] = await harness.db
      .select()
      .from(inboxRoutingLog)
      .where(eq(inboxRoutingLog.batchId, batchId));
    expect(logRow!.action).toBe('skipped');
  });

  it('flag_tax routes to Tax Returns/ and creates a tax return', async () => {
    const f = await setup();
    const inboxKey = 'Inbox/Test Client Co_123456_2024-1040.pdf';
    const { storage, keys } = fakeStorage([inboxKey]);
    await scanInbox(harness.db, storage, f.firmId);
    await harness.db
      .update(inboxItems)
      .set({ reviewAction: 'flag_tax', flagFormCode: '1040', flagTaxYear: 2024 })
      .where(eq(inboxItems.firmId, f.firmId));
    const [item] = await harness.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.firmId, f.firmId));
    const batchId = '00000000-0000-4000-8000-0000000000cc';
    await runFilerRoute(harness.db, storage, log, {
      kind: 'route',
      firmId: f.firmId,
      actorId: f.appUserId,
      batchId,
      itemId: item!.id,
    });
    expect(keys().some((k) => k.startsWith('Test Client Co/Tax Returns/'))).toBe(true);
    const [logRow] = await harness.db
      .select()
      .from(inboxRoutingLog)
      .where(eq(inboxRoutingLog.batchId, batchId));
    expect(logRow!.action).toBe('tax_flagged');
    expect(logRow!.taxReturnId).not.toBeNull();
  });
});

// Touch a schema import so unused-import lint stays quiet if assertions change.
void inboxRoutingProfiles;
void and;
