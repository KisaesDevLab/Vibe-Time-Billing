// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Vibe Filer — scan/match + route + undo end-to-end (pglite + fake B2).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
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
import { scanInbox, matchObject, matchK1Recipient } from '../filer/scan';
import { createFilerRouter } from '../filer/router';
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

  // 0152 — second identifier: the matcher accepts external_id OR aws_id.
  const awsClients = [
    ...clientsList,
    { id: 'c4', name: 'Delta Holdings', externalId: '777777', awsId: 'AWS9001', status: 'ACTIVE' },
  ];
  const awsBound = new Set(['c1', 'c2', 'c4']);

  it('aws id: strict name_ID slot matches', () => {
    const r = matchObject('Delta Holdings_AWS9001_2024.pdf', awsClients, [], awsBound);
    expect(r.matchStatus).toBe('matched');
    expect(r.matchedClient).toBe('c4');
  });
  it('aws id: matches anywhere in the filename', () => {
    const r = matchObject('2024 K1 AWS9001.pdf', awsClients, [], awsBound);
    expect(r.matchStatus).toBe('matched');
    expect(r.matchedClient).toBe('c4');
    expect(r.parsedId).toBe('AWS9001');
  });
  it('aws id: external id still wins for the same client', () => {
    const r = matchObject('Delta Holdings_777777_2024.pdf', awsClients, [], awsBound);
    expect(r.matchStatus).toBe('matched');
    expect(r.matchedClient).toBe('c4');
  });
  it('aws id: hit on one client + external hit on another → ambiguous, falls through', () => {
    const r = matchObject('123456 AWS9001 transfer.pdf', awsClients, [], awsBound);
    expect(r.matchedClient).toBeNull();
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

describe('inbox upload route', () => {
  function buildApp(storage: StorageClient, firmId: string, appUserId: string): express.Express {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { staffSession: unknown }).staffSession = { firmId, appUserId };
      next();
    });
    app.use(
      '/api/staff/filer',
      createFilerRouter({
        db: harness.db,
        storage,
        fakeUserRoles: new Map([[appUserId, ['admin']]]),
      }),
    );
    return app;
  }

  it('puts the raw body under Inbox/ and resolves filename collisions', async () => {
    const f = await setup();
    const { storage, keys } = fakeStorage([]);
    const app = buildApp(storage, f.firmId, f.appUserId);

    const res = await request(app)
      .post('/api/staff/filer/upload')
      .query({ filename: 'Test Client Co_123456_W2.pdf', mimeType: 'application/pdf' })
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4 fake'));
    expect(res.status).toBe(201);
    expect(res.body.key).toBe('Inbox/Test Client Co_123456_W2.pdf');
    expect(keys()).toContain('Inbox/Test Client Co_123456_W2.pdf');

    const dup = await request(app)
      .post('/api/staff/filer/upload')
      .query({ filename: 'Test Client Co_123456_W2.pdf' })
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4 fake again'));
    expect(dup.status).toBe(201);
    expect(dup.body.key).toBe('Inbox/Test Client Co_123456_W2 (2).pdf');

    // A re-scan picks the uploaded object up as a matched inbox item.
    await scanInbox(harness.db, storage, f.firmId);
    const rows = await harness.db.select().from(inboxItems).where(eq(inboxItems.firmId, f.firmId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.matchStatus === 'matched')).toBe(true);
  });

  it('rejects blocked extensions, missing filename, and empty bodies', async () => {
    const f = await setup();
    const { storage, keys } = fakeStorage([]);
    const app = buildApp(storage, f.firmId, f.appUserId);

    const blocked = await request(app)
      .post('/api/staff/filer/upload')
      .query({ filename: 'evil.exe' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('MZ'));
    expect(blocked.status).toBe(415);

    const noName = await request(app)
      .post('/api/staff/filer/upload')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('x'));
    expect(noName.status).toBe(400);

    const empty = await request(app)
      .post('/api/staff/filer/upload')
      .query({ filename: 'a.pdf' })
      .set('Content-Type', 'application/pdf')
      .send();
    expect(empty.status).toBe(400);

    expect(keys()).toHaveLength(0);
  });
});

// ── 0229 — K-1 recipient secondary match ────────────────────────────────

const K1_NAME = 'Test Client Co_123456_2025_1120S_K1_Package_Joe Black_9911_PARK.pdf';
const K1_KEY = `Inbox/${K1_NAME}`;

/** Second client (the K-1 recipient) with a bound folder. */
async function seedRecipient(firmId: string, entityClientId: string): Promise<string> {
  const r = await harness.db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
        SELECT firm_id, 'Black, Joe & Jane', partner_in_charge_id, office_id
        FROM client WHERE id = ${entityClientId} RETURNING id`,
  );
  const recipientId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.insert(clientFolders).values({
    firmId,
    clientId: recipientId,
    storagePath: 'Black Joe/',
  });
  return recipientId;
}

describe('matchK1Recipient (pure)', () => {
  const list = [
    { id: 'entity', name: 'Parkway, LLC', externalId: 'PARK', status: 'ACTIVE' },
    { id: 'joe', name: 'Black, Joe & Jane', externalId: '6111', status: 'ACTIVE' },
    { id: 'other', name: 'Wilson, Ted', externalId: '7222', status: 'ACTIVE' },
  ];

  it('matches First Last against a Last, First & Spouse record', () => {
    const r = matchK1Recipient({ recipientName: 'Joe Black', raw: '' }, list, 'entity');
    expect(r.matchedClient).toBe('joe');
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });

  it('matches the spouse variant', () => {
    const r = matchK1Recipient({ recipientName: 'Jane Black', raw: '' }, list, 'entity');
    expect(r.matchedClient).toBe('joe');
  });

  it('never suggests the primary-matched entity', () => {
    const r = matchK1Recipient({ recipientName: 'Parkway', raw: '' }, list, 'entity');
    expect(r.matchedClient).not.toBe('entity');
  });

  it('below threshold → null result', () => {
    const r = matchK1Recipient({ recipientName: 'Zed Quux', raw: '' }, list, 'entity');
    expect(r.matchedClient).toBeNull();
    expect(r.score).toBeNull();
  });
});

describe('scanInbox — K-1 suggestions', () => {
  it('persists the recipient suggestion columns', async () => {
    const f = await setup();
    const recipientId = await seedRecipient(f.firmId, f.clientId);
    const { storage } = fakeStorage([K1_KEY]);
    await scanInbox(harness.db, storage, f.firmId);
    const [row] = await harness.db.select().from(inboxItems).where(eq(inboxItems.firmId, f.firmId));
    expect(row!.matchedClient).toBe(f.clientId); // primary entity match intact
    expect(row!.k1RecipientName).toBe('Joe Black');
    expect(row!.k1MatchedClient).toBe(recipientId);
    expect(row!.k1Status).toBe('suggested');
    expect(row!.k1MatchScore).toBeGreaterThanOrEqual(0.85);
  });

  it('re-scan refreshes suggested but preserves confirmed/dismissed', async () => {
    const f = await setup();
    const recipientId = await seedRecipient(f.firmId, f.clientId);
    const { storage } = fakeStorage([K1_KEY]);
    await scanInbox(harness.db, storage, f.firmId);
    await harness.db
      .update(inboxItems)
      .set({ k1Status: 'confirmed' })
      .where(eq(inboxItems.firmId, f.firmId));
    await scanInbox(harness.db, storage, f.firmId);
    const [row] = await harness.db.select().from(inboxItems).where(eq(inboxItems.firmId, f.firmId));
    expect(row!.k1Status).toBe('confirmed'); // preserved
    expect(row!.k1MatchedClient).toBe(recipientId);
  });

  it('non-K-1 filenames leave the k1 columns null', async () => {
    const f = await setup();
    const { storage } = fakeStorage(['Inbox/Test Client Co_123456_2024-1040.pdf']);
    await scanInbox(harness.db, storage, f.firmId);
    const [row] = await harness.db.select().from(inboxItems).where(eq(inboxItems.firmId, f.firmId));
    expect(row!.k1RecipientName).toBeNull();
    expect(row!.k1Status).toBeNull();
  });
});

describe('PATCH /inbox/:id — K-1 verification rules', () => {
  function buildApp(firmId: string, appUserId: string): express.Express {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { staffSession: unknown }).staffSession = { firmId, appUserId };
      next();
    });
    app.use(
      '/api/staff/filer',
      createFilerRouter({
        db: harness.db,
        storage: fakeStorage([]).storage,
        fakeUserRoles: new Map([[appUserId, ['admin']]]),
      }),
    );
    return app;
  }

  it('search implies confirmed; entity self-target and confirm-without-client are rejected', async () => {
    const f = await setup();
    const recipientId = await seedRecipient(f.firmId, f.clientId);
    const { storage } = fakeStorage([K1_KEY]);
    await scanInbox(harness.db, storage, f.firmId);
    // Clear the suggestion so the picks below start from nothing.
    await harness.db
      .update(inboxItems)
      .set({ k1MatchedClient: null, k1MatchScore: null })
      .where(eq(inboxItems.firmId, f.firmId));
    const [item] = await harness.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.firmId, f.firmId));
    const app = buildApp(f.firmId, f.appUserId);

    // Confirm without a recipient client → 400.
    const noClient = await request(app)
      .patch(`/api/staff/filer/inbox/${item!.id}`)
      .send({ k1Status: 'confirmed' });
    expect(noClient.status).toBe(400);
    expect(noClient.body.error).toBe('k1_client_required');

    // Picking the entity itself → 400.
    const selfPick = await request(app)
      .patch(`/api/staff/filer/inbox/${item!.id}`)
      .send({ k1MatchedClient: f.clientId });
    expect(selfPick.status).toBe(400);
    expect(selfPick.body.error).toBe('k1_same_as_entity');

    // Picking the recipient via search implies confirmation.
    const pick = await request(app)
      .patch(`/api/staff/filer/inbox/${item!.id}`)
      .send({ k1MatchedClient: recipientId });
    expect(pick.status).toBe(200);
    const [after] = await harness.db.select().from(inboxItems).where(eq(inboxItems.id, item!.id));
    expect(after!.k1MatchedClient).toBe(recipientId);
    expect(after!.k1Status).toBe('confirmed');
  });
});

describe('route + undo — K-1 recipient copy', () => {
  it('confirmed recipient gets an additional copy; k1-only undo removes just that copy', async () => {
    const f = await setup();
    const recipientId = await seedRecipient(f.firmId, f.clientId);
    const { storage, keys } = fakeStorage([K1_KEY]);
    await scanInbox(harness.db, storage, f.firmId);
    await harness.db
      .update(inboxItems)
      .set({ k1Status: 'confirmed', k1MatchedClient: recipientId })
      .where(eq(inboxItems.firmId, f.firmId));
    const [item] = await harness.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.firmId, f.firmId));

    const batchId = '00000000-0000-4000-8000-0000000000dd';
    await runFilerRoute(harness.db, storage, log, {
      kind: 'route',
      firmId: f.firmId,
      actorId: f.appUserId,
      batchId,
      itemId: item!.id,
    });

    // Source gone; primary copy in the entity folder; recipient copy at
    // the default Income Tax/{year}/ destination (no active profile).
    const live = keys();
    expect(live).not.toContain(K1_KEY);
    const stripped = 'Test Client Co_2025_1120S_K1_Package_Joe Black_9911_PARK.pdf';
    expect(live).toContain(`Test Client Co/${stripped}`);
    expect(live).toContain(`Black Joe/Income Tax/2025/${stripped}`);

    const logRows = await harness.db
      .select()
      .from(inboxRoutingLog)
      .where(eq(inboxRoutingLog.batchId, batchId));
    expect(logRows).toHaveLength(2);
    const k1Log = logRows.find((l) => l.action === 'k1_recipient');
    expect(k1Log).toBeDefined();
    expect(k1Log!.clientId).toBe(recipientId);
    expect(k1Log!.status).toBe('success');

    // Undo just the K-1 leg: recipient copy removed, primary copy stays,
    // nothing reappears in the inbox.
    await runFilerRoute(harness.db, storage, log, {
      kind: 'undo',
      firmId: f.firmId,
      actorId: f.appUserId,
      logId: k1Log!.id,
    });
    const afterUndo = keys();
    expect(afterUndo).not.toContain(`Black Joe/Income Tax/2025/${stripped}`);
    expect(afterUndo).toContain(`Test Client Co/${stripped}`);
    expect(afterUndo).not.toContain(K1_KEY);
    const remaining = await harness.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.firmId, f.firmId));
    expect(remaining).toHaveLength(0);
    const [reversed] = await harness.db
      .select()
      .from(inboxRoutingLog)
      .where(eq(inboxRoutingLog.id, k1Log!.id));
    expect(reversed!.status).toBe('reversed');
  });

  it('retry after a logged primary performs only the K-1 leg', async () => {
    const f = await setup();
    const recipientId = await seedRecipient(f.firmId, f.clientId);
    const { storage, keys } = fakeStorage([K1_KEY]);
    await scanInbox(harness.db, storage, f.firmId);
    await harness.db
      .update(inboxItems)
      .set({ k1Status: 'confirmed', k1MatchedClient: recipientId })
      .where(eq(inboxItems.firmId, f.firmId));
    const [item] = await harness.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.firmId, f.firmId));

    // Simulate a crash after the primary copy + log but before the K-1
    // leg: pre-insert the primary success log for this batch/source.
    const batchId = '00000000-0000-4000-8000-0000000000ee';
    await harness.db.insert(inboxRoutingLog).values({
      batchId,
      firmId: f.firmId,
      objectKeyFrom: item!.objectKey,
      objectKeyTo: 'Test Client Co/already-filed.pdf',
      clientId: f.clientId,
      action: 'filed',
      userId: f.appUserId,
      status: 'success',
    });

    await runFilerRoute(harness.db, storage, log, {
      kind: 'route',
      firmId: f.firmId,
      actorId: f.appUserId,
      batchId,
      itemId: item!.id,
    });

    // Only the recipient copy was made (no second primary copy), the
    // source is cleaned up, and both success logs exist.
    const live = keys();
    const stripped = 'Test Client Co_2025_1120S_K1_Package_Joe Black_9911_PARK.pdf';
    expect(live).toContain(`Black Joe/Income Tax/2025/${stripped}`);
    expect(live).not.toContain(`Test Client Co/${stripped}`);
    expect(live).not.toContain(K1_KEY);
    const logRows = await harness.db
      .select()
      .from(inboxRoutingLog)
      .where(eq(inboxRoutingLog.batchId, batchId));
    expect(logRows.map((l) => l.action).sort()).toEqual(['filed', 'k1_recipient']);
  });
});

// Touch a schema import so unused-import lint stays quiet if assertions change.
void inboxRoutingProfiles;
void and;
