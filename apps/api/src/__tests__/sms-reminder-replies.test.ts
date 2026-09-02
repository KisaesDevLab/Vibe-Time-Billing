// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// D13 / Phase 12 — reminder reply parsing inside ingest: "C" confirms the
// participant, marks the text read, and auto-replies; "R" opens a
// reschedule request, notifies the assignee, stays unread; other texts
// fall through to the normal inbox flow.

import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appointmentParticipants,
  appointmentRescheduleRequests,
  smsConversations,
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
import { ingestInboundMessage } from '../sms/ingest';
import { _resetInboxReaderCacheForTests } from '../sms/notify';
import { createReminderReplyHook } from '../sms/reminder-replies';
import type { SmsSendArgs, SmsSendService } from '../sms/send-service';

const log = pino({ enabled: false });
const LINE = '+12025550100';
const FROM = '+13125550148';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let lineId: string;
let contactId: string;
let personId: string;
let appointmentId: string;
let sent: SmsSendArgs[];
let sidN = 0;

const smsSend: SmsSendService = {
  async send(args) {
    sent.push(args);
    return { ok: true, mode: 'inbox', messageId: 'auto', conversationId: null };
  },
};

async function inbound(body: string) {
  sidN += 1;
  return ingestInboundMessage(
    { db: harness.db, log, onInbound: createReminderReplyHook({ smsSend, log }) },
    {
      providerMessageId: `SM${String(sidN).padStart(32, '0')}`,
      from: FROM,
      to: LINE,
      body,
      numMedia: 0,
      media: [],
    },
    { source: 'webhook' },
  );
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  _resetInboxReaderCacheForTests();
  sent = [];
  await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})`);
  ({ lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE }));
  ({ contactId, personId } = await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Pat',
    mobile: FROM,
  }));
  const appt = await harness.db.execute(
    sql`INSERT INTO appointment (firm_id, client_id, title, starts_at, ends_at, status, lead_app_user_id)
        VALUES (${seed.firmId}, ${seed.clientId}, 'Tax planning', now() + interval '2 days', now() + interval '2 days' + interval '1 hour', 'SCHEDULED', ${seed.appUserId}) RETURNING id`,
  );
  appointmentId = (appt as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db
    .insert(appointmentParticipants)
    .values({ appointmentId, clientContactId: contactId, rsvpStatus: 'pending' } as never);
  // A reminder went out to this number from the inbox (reply context).
  const [conv] = await harness.db
    .insert(smsConversations)
    .values({
      firmId: seed.firmId,
      lineId,
      externalNumberE164: FROM,
      personId,
      clientContactId: contactId,
      clientId: seed.clientId,
      assignedUserId: seed.appUserId,
    })
    .returning({ id: smsConversations.id });
  await harness.db.insert(smsMessages).values({
    firmId: seed.firmId,
    conversationId: conv!.id,
    direction: 'outbound',
    fromE164: LINE,
    toE164: FROM,
    body: 'Reminder: Tax planning in 2 days. Reply C to confirm or R to reschedule.',
    providerMessageId: 'SMREMINDER',
    providerStatus: 'delivered',
    contextKind: 'appointment_reminder',
    appointmentId,
  });
});

afterEach(async () => {
  await harness.close();
});

describe('reminder reply parsing', () => {
  it('"C" confirms the participant, marks the text read, and auto-replies', async () => {
    const r = await inbound('C');
    expect(r.status).toBe('created');
    const [p] = await harness.db
      .select()
      .from(appointmentParticipants)
      .where(eq(appointmentParticipants.appointmentId, appointmentId));
    expect(p!.rsvpStatus).toBe('confirmed');
    const msgs = await harness.db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.direction, 'inbound'));
    expect(msgs[0]!.parsedIntent).toBe('confirm');
    expect(msgs[0]!.appointmentId).toBe(appointmentId);
    expect(msgs[0]!.readAt).toBeTruthy();
    const [conv] = await harness.db.select().from(smsConversations);
    expect(conv!.unreadCount).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.context).toMatchObject({ kind: 'auto_reply', appointmentId });
    expect(sent[0]!.body).toContain('confirmed');
    // no generic "new text" notification for a handled confirm
    expect(await harness.db.select().from(staffNotifications)).toHaveLength(0);
  });

  it('"R" opens a reschedule request, notifies the assignee, stays unread', async () => {
    await inbound('R — can we do Friday?');
    const reqs = await harness.db.select().from(appointmentRescheduleRequests);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.requestedByContactId).toBe(contactId);
    const msgs = await harness.db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.direction, 'inbound'));
    expect(msgs[0]!.parsedIntent).toBe('reschedule');
    expect(msgs[0]!.readAt).toBeNull();
    const [conv] = await harness.db.select().from(smsConversations);
    expect(conv!.unreadCount).toBe(1);
    const notes = await harness.db.select().from(staffNotifications);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe('sms_reschedule_request');
    expect(notes[0]!.recipientAppUserId).toBe(seed.appUserId);
    expect(sent).toHaveLength(0);
  });

  it('an ordinary text is not parsed', async () => {
    await inbound('Running 10 minutes late');
    const msgs = await harness.db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.direction, 'inbound'));
    expect(msgs[0]!.parsedIntent).toBeNull();
    expect(msgs[0]!.readAt).toBeNull();
    const notes = await harness.db.select().from(staffNotifications);
    expect(notes.map((n) => n.type)).toEqual(['sms_inbound']);
  });
});
