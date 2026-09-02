// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 — polling reconciler: imports inbound texts the webhook missed
// (paging, overlap dedupe, cursor advance), back-fills stuck outbound
// status (incl. 21610 → opt-out), re-queues undeleted media, detects a
// webhook gap (health + one admin notification), refreshes A2P, and
// honors the per-firm interval.

import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crypto as core } from '@vibe/core';
import {
  persons,
  smsConversations,
  smsLines,
  smsMedia,
  smsMessages,
  staffNotifications,
} from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { _resetInboxReaderCacheForTests } from '../sms/notify';
import type { TwilioClient, TwilioMessage } from '../sms/twilio-client';
import { runSmsPollTick } from '../../../worker/src/jobs/sms-poll';

const KMS_KEY = 'a'.repeat(64);
const AC = 'AC' + 'a'.repeat(32);
const MG = 'MG' + 'b'.repeat(32);
const LINE = '+12025550100';
const log = pino({ enabled: false });

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let remoteInbound: TwilioMessage[];
let remoteStatus: Record<string, Partial<TwilioMessage>>;
let listCalls: Array<{ to?: string; dateSentAfter?: Date }>;
let enqueued: string[];
let a2p: 'registered' | 'unregistered' = 'registered';

function msg(
  sid: string,
  body: string,
  sentIso: string,
  extra: Partial<TwilioMessage> = {},
): TwilioMessage {
  return {
    sid,
    from: '+13125550148',
    to: LINE,
    body,
    status: 'received',
    direction: 'inbound',
    numSegments: 1,
    numMedia: 0,
    errorCode: null,
    errorMessage: null,
    dateSent: new Date(sentIso),
    dateCreated: new Date(sentIso),
    messagingServiceSid: MG,
    mediaUri: null,
    ...extra,
  };
}

function fakeTwilio(): TwilioClient {
  return {
    listMessages(args: { to?: string; dateSentAfter?: Date }) {
      listCalls.push(args);
      const since = args.dateSentAfter?.getTime() ?? 0;
      const items = remoteInbound.filter((m) => (m.dateSent?.getTime() ?? 0) > since);
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of items) yield m;
        },
      };
    },
    async getMessage(sid: string) {
      return {
        ...msg(sid, '', '2026-09-02T10:00:00Z', { direction: 'outbound-api' }),
        ...(remoteStatus[sid] ?? {}),
      };
    },
    async listMedia() {
      return [];
    },
    async getA2pStatus() {
      return a2p;
    },
  } as unknown as TwilioClient;
}

async function enableInbox(intervalMinutes = 2): Promise<void> {
  const envelope = core.encryptJson(
    { provider: 'twilio', accountSid: AC, authToken: 'token-12345', messagingServiceSid: MG },
    core.resolveKey(KMS_KEY),
  );
  await harness.db.execute(
    sql`UPDATE firm_settings SET sms_config_encrypted = ${envelope}, sms_inbox_enabled = true,
        sms_poll_interval_minutes = ${intervalMinutes} WHERE firm_id = ${seed.firmId}`,
  );
}

function deps(now: Date) {
  return {
    now: () => now,
    twilioClient: () => fakeTwilio(),
    enqueueMedia: async (j: { mediaId: string }) => {
      enqueued.push(j.mediaId);
    },
  };
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  process.env['KMS_KEY'] = KMS_KEY;
  _resetInboxReaderCacheForTests();
  await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})`);
  await harness.db
    .execute(
      sql`INSERT INTO user_role (app_user_id, role_id) SELECT ${seed.appUserId}, id FROM role WHERE firm_id = ${seed.firmId} AND lower(name) = 'admin'`,
    )
    .catch(() => undefined);
  remoteInbound = [];
  remoteStatus = {};
  listCalls = [];
  enqueued = [];
  a2p = 'registered';
});

afterEach(async () => {
  await harness.close();
});

describe('runSmsPollTick', () => {
  it('does nothing for firms without the inbox enabled', async () => {
    const r = await runSmsPollTick(harness.db, log, deps(new Date('2026-09-02T12:00:00Z')));
    expect(r.firms).toBe(0);
  });

  it('imports missed inbound texts, advances the cursor, and dedupes the overlap', async () => {
    await enableInbox();
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat',
      mobile: '+13125550148',
    });
    remoteInbound = [
      msg('SM1', 'first', '2026-09-02T11:50:00Z'),
      msg('SM2', 'second', '2026-09-02T11:55:00Z'),
    ];
    const now = new Date('2026-09-02T12:00:00Z');
    const r1 = await runSmsPollTick(harness.db, log, deps(now));
    expect(r1.firms).toBe(1);
    expect(r1.linesPolled).toBe(1);
    expect(r1.inboundImported).toBe(2);
    expect(await harness.db.select().from(smsMessages)).toHaveLength(2);
    const [line] = await harness.db.select().from(smsLines);
    expect(line!.pollCursorAt?.toISOString()).toBe('2026-09-02T11:55:00.000Z');
    expect(line!.lastPolledAt?.toISOString()).toBe(now.toISOString());
    const [conv] = await harness.db.select().from(smsConversations);
    expect(conv!.unreadCount).toBe(2);
    expect(conv!.clientId).toBe(seed.clientId);
    // first poll looks back 24h - overlap
    expect(listCalls[0]!.dateSentAfter!.getTime()).toBeLessThan(now.getTime() - 23 * 3600_000);
    const msgs = await harness.db.select().from(smsMessages);
    expect(msgs.every((m) => m.ingestSource === 'poll')).toBe(true);

    // second tick: overlap re-lists SM2, plus one new one → only the new one lands
    remoteInbound.push(msg('SM3', 'third', '2026-09-02T12:01:00Z'));
    const later = new Date('2026-09-02T12:03:00Z');
    const r2 = await runSmsPollTick(harness.db, log, deps(later));
    expect(r2.inboundImported).toBe(1);
    expect(listCalls[1]!.dateSentAfter!.toISOString()).toBe('2026-09-02T11:50:00.000Z'); // cursor - 5min
    expect(await harness.db.select().from(smsMessages)).toHaveLength(3);
  });

  it('honors the per-firm interval', async () => {
    await enableInbox(10);
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    const now = new Date('2026-09-02T12:00:00Z');
    expect((await runSmsPollTick(harness.db, log, deps(now))).firms).toBe(1);
    expect(
      (await runSmsPollTick(harness.db, log, deps(new Date('2026-09-02T12:04:00Z')))).firms,
    ).toBe(0);
    expect(
      (await runSmsPollTick(harness.db, log, deps(new Date('2026-09-02T12:11:00Z')))).firms,
    ).toBe(1);
    expect(
      (
        await runSmsPollTick(harness.db, log, {
          ...deps(new Date('2026-09-02T12:12:00Z')),
          force: true,
        })
      ).firms,
    ).toBe(1);
  });

  it('back-fills stuck outbound status and flips opt-out on 21610', async () => {
    await enableInbox();
    const { lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat',
      mobile: '+13125550148',
    });
    const [conv] = await harness.db
      .insert(smsConversations)
      .values({ firmId: seed.firmId, lineId, externalNumberE164: '+13125550148', personId })
      .returning({ id: smsConversations.id });
    const old = new Date('2026-09-02T11:00:00Z');
    const base = {
      firmId: seed.firmId,
      conversationId: conv!.id,
      direction: 'outbound' as const,
      fromE164: LINE,
      toE164: '+13125550148',
      body: 'x',
      contextKind: 'manual' as const,
      createdAt: old,
    };
    await harness.db.insert(smsMessages).values([
      { ...base, providerMessageId: 'SMA', providerStatus: 'sent' },
      { ...base, providerMessageId: 'SMB', providerStatus: 'queued' },
      { ...base, providerMessageId: 'SMC', providerStatus: 'delivered' }, // terminal: untouched
      {
        ...base,
        providerMessageId: 'SMD',
        providerStatus: 'queued',
        createdAt: new Date('2026-09-02T11:58:00Z'),
      }, // too fresh
    ]);
    remoteStatus = {
      SMA: { status: 'delivered' },
      SMB: { status: 'failed', errorCode: 21610, errorMessage: 'unsubscribed' },
      SMD: { status: 'delivered' },
    };
    const r = await runSmsPollTick(harness.db, log, deps(new Date('2026-09-02T12:00:00Z')));
    expect(r.statusReconciled).toBe(2);
    const rows = await harness.db.select().from(smsMessages);
    const byId = Object.fromEntries(rows.map((m) => [m.providerMessageId, m]));
    expect(byId['SMA']!.providerStatus).toBe('delivered');
    expect(byId['SMB']!.providerStatus).toBe('failed');
    expect(byId['SMB']!.providerErrorCode).toBe(21610);
    expect(byId['SMD']!.providerStatus).toBe('queued');
    const [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsOptOut).toBe(true);
  });

  it('re-queues failed and undeleted media', async () => {
    await enableInbox();
    const { lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    const [conv] = await harness.db
      .insert(smsConversations)
      .values({ firmId: seed.firmId, lineId, externalNumberE164: '+13125550148' })
      .returning({ id: smsConversations.id });
    const [m] = await harness.db
      .insert(smsMessages)
      .values({
        firmId: seed.firmId,
        conversationId: conv!.id,
        direction: 'inbound',
        fromE164: '+13125550148',
        toE164: LINE,
        body: '',
        providerMessageId: 'MM1',
        providerStatus: 'received',
        contextKind: 'inbound',
      })
      .returning({ id: smsMessages.id });
    const old = new Date('2026-09-02T11:00:00Z');
    await harness.db.insert(smsMedia).values([
      {
        firmId: seed.firmId,
        messageId: m!.id,
        providerMediaSid: 'ME1',
        status: 'failed',
        updatedAt: old,
        attemptCount: 5,
      },
      {
        firmId: seed.firmId,
        messageId: m!.id,
        providerMediaSid: 'ME2',
        status: 'stored',
        remoteDeleted: false,
        updatedAt: old,
      },
      {
        firmId: seed.firmId,
        messageId: m!.id,
        providerMediaSid: 'ME3',
        status: 'intake',
        remoteDeleted: true,
        updatedAt: old,
      },
    ]);
    const r = await runSmsPollTick(harness.db, log, deps(new Date('2026-09-02T12:00:00Z')));
    expect(r.mediaRetried).toBe(2);
    expect(enqueued).toHaveLength(2);
    const failed = await harness.db
      .select()
      .from(smsMedia)
      .where(eq(smsMedia.providerMediaSid, 'ME1'));
    expect(failed[0]!.status).toBe('pending');
    expect(failed[0]!.attemptCount).toBe(0);
  });

  it('detects a webhook gap, records health, and notifies admins once a day', async () => {
    await enableInbox();
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    remoteInbound = [msg('SM1', 'missed', '2026-09-02T11:50:00Z')];
    const r = await runSmsPollTick(harness.db, log, deps(new Date('2026-09-02T12:00:00Z')));
    expect(r.gapDetected).toBe(true);
    const h = await harness.db.execute(sql`SELECT sms_health FROM firm_settings`);
    const health = (
      h as unknown as {
        rows: { sms_health: { webhook?: { gapDetectedAt?: string; missedSincePoll?: number } } }[];
      }
    ).rows[0]!.sms_health;
    expect(health.webhook?.gapDetectedAt).toBeTruthy();
    expect(health.webhook?.missedSincePoll).toBe(1);
    const notes = await harness.db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.type, 'sms_webhook_gap'));
    expect(notes.length).toBeLessThanOrEqual(1);
    // a second gap the same day does not re-notify
    remoteInbound.push(msg('SM2', 'missed again', '2026-09-02T12:05:00Z'));
    await runSmsPollTick(harness.db, log, deps(new Date('2026-09-02T12:10:00Z')));
    const notes2 = await harness.db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.type, 'sms_webhook_gap'));
    expect(notes2.length).toBe(notes.length);
    // no gap when the webhook has delivered since
    await harness.db.execute(
      sql`UPDATE firm_settings SET sms_last_inbound_webhook_at = '2026-09-02T12:20:00Z'`,
    );
    remoteInbound.push(msg('SM3', 'seen by webhook too', '2026-09-02T12:15:00Z'));
    const r3 = await runSmsPollTick(harness.db, log, deps(new Date('2026-09-02T12:25:00Z')));
    expect(r3.gapDetected).toBe(false);
  });

  it('refreshes the A2P status every 6 hours', async () => {
    await enableInbox();
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    a2p = 'unregistered';
    const r = await runSmsPollTick(harness.db, log, deps(new Date('2026-09-02T12:00:00Z')));
    expect(r.a2pRefreshed).toBe(1);
    const fs = await harness.db.execute(sql`SELECT sms_a2p_status AS s FROM firm_settings`);
    expect((fs as unknown as { rows: { s: string }[] }).rows[0]!.s).toBe('unregistered');
    const r2 = await runSmsPollTick(harness.db, log, deps(new Date('2026-09-02T13:00:00Z')));
    expect(r2.a2pRefreshed).toBe(0);
  });
});
