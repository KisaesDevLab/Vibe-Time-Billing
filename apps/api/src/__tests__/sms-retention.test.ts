// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 / D10 — retention: unassigned conversations purge after the firm's
// unassigned window, spam / closed-unassigned after the spam window,
// client-linked conversations are never touched, and media objects are
// removed from storage before the rows cascade.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { smsConversations, smsMedia, smsMessages } from '@vibe/db/schema';
import { MockStorageClient } from '@vibe/storage';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { runSmsRetention } from '../../../worker/src/jobs/sms-retention';

const log = pino({ enabled: false });
const NOW = new Date('2026-09-02T12:00:00Z');
const days = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let lineId: string;
let storage: MockStorageClient;
let tmp: string;

const mediaKeys: string[] = [];

async function conv(
  extra: Partial<typeof smsConversations.$inferInsert>,
  withMedia = false,
): Promise<string> {
  const [c] = await harness.db
    .insert(smsConversations)
    .values({
      firmId: seed.firmId,
      lineId,
      externalNumberE164: `+1312555${Math.floor(Math.random() * 9000 + 1000)}`,
      ...extra,
    })
    .returning({ id: smsConversations.id });
  const [m] = await harness.db
    .insert(smsMessages)
    .values({
      firmId: seed.firmId,
      conversationId: c!.id,
      direction: 'inbound',
      fromE164: '+13125550148',
      toE164: '+12025550100',
      body: 'x',
      contextKind: 'inbound',
    })
    .returning({ id: smsMessages.id });
  if (withMedia) {
    const key = `system/sms-media/${seed.firmId}/${c!.id}/${m!.id}/ME1.jpg`;
    await storage.put(key, Buffer.from('JPEG'), { contentType: 'image/jpeg' });
    mediaKeys.push(key);
    await harness.db.insert(smsMedia).values({
      firmId: seed.firmId,
      messageId: m!.id,
      providerMediaSid: 'ME1',
      storageKey: key,
      status: 'stored',
    });
  }
  return c!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  ({ lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId }));
  await harness.db.execute(
    sql`INSERT INTO firm_settings (firm_id, sms_unassigned_retention_days, sms_spam_retention_days) VALUES (${seed.firmId}, 90, 30)`,
  );
  tmp = mkdtempSync(join(tmpdir(), 'sms-ret-'));
  storage = new MockStorageClient({ rootPath: tmp });
});

afterEach(async () => {
  await harness.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('runSmsRetention', () => {
  it('purges by window, keeps client-linked threads, deletes media', async () => {
    const oldUnassigned = await conv({ lastMessageAt: days(91) }, true);
    const freshUnassigned = await conv({ lastMessageAt: days(10) });
    const oldSpam = await conv({ status: 'spam', lastMessageAt: days(31) });
    const freshSpam = await conv({ status: 'spam', lastMessageAt: days(5) });
    const oldClosedUnassigned = await conv({ status: 'closed', lastMessageAt: days(45) });
    const oldClientLinked = await conv({ clientId: seed.clientId, lastMessageAt: days(400) });
    const oldClosedClient = await conv({
      clientId: seed.clientId,
      status: 'closed',
      lastMessageAt: days(400),
    });
    const r = await runSmsRetention(harness.db, storage, log, NOW);
    expect(r.conversationsPurged).toBe(3);
    expect(r.mediaDeleted).toBe(1);
    const left = (await harness.db.select({ id: smsConversations.id }).from(smsConversations))
      .map((c) => c.id)
      .sort();
    expect(left).toEqual([freshUnassigned, freshSpam, oldClientLinked, oldClosedClient].sort());
    expect(left).not.toContain(oldUnassigned);
    expect(left).not.toContain(oldSpam);
    expect(left).not.toContain(oldClosedUnassigned);
    expect(await harness.db.select().from(smsMedia)).toHaveLength(0);
    expect(await storage.head(mediaKeys[0]!)).toBeNull();
  });

  it('is a no-op when nothing is due', async () => {
    await conv({ lastMessageAt: days(1) });
    const r = await runSmsRetention(harness.db, storage, log, NOW);
    expect(r.conversationsPurged).toBe(0);
    expect(r.firms).toBe(0);
  });
});
