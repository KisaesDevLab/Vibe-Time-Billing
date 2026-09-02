// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 — SmsSendService: legacy fallback when the inbox is off, security
// bypass, conversation + message rows written BEFORE the provider call,
// sid/segments recorded, gate order (opt-out → consent → A2P), consent
// bypass inside an inbound-initiated conversation, 21610 → opt-out, and
// line selection (existing thread's line beats the default line).

import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crypto as core } from '@vibe/core';
import { persons, smsConversations, smsLines, smsMessages, notificationLog } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import type { SmsProvider } from '../sms/provider';
import { createSmsSendService, type SmsSendService } from '../sms/send-service';

const KMS_KEY = 'a'.repeat(64);
const AC = 'AC' + 'a'.repeat(32);
const MG = 'MG' + 'b'.repeat(32);
const log = pino({ enabled: false });

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let twilioCalls: Array<{ url: string; body: string }>;
let twilioReply: () => { status: number; json: unknown };
let fallbackCalls: Array<{ to: string; body: string }>;

const fallback: SmsProvider = {
  id: 'textlink',
  async send(m) {
    fallbackCalls.push(m);
    return { ok: true, providerMessageId: 'TL1' };
  },
};

let sidCounter = 0;
const fetchImpl = (async (url: string, init?: RequestInit) => {
  twilioCalls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
  const r = twilioReply();
  // Real Twilio sids are unique per message; a fixed sid would trip the
  // provider_message_id unique index on the second send of a test.
  if (r.status < 300 && r.json && typeof r.json === 'object' && 'sid' in r.json) {
    sidCounter += 1;
    r.json = { ...(r.json as Record<string, unknown>), sid: `SM${sidCounter}` };
  }
  return { ok: r.status < 300, status: r.status, json: async () => r.json } as unknown as Response;
}) as unknown as typeof fetch;

function service(): SmsSendService {
  return createSmsSendService({
    db: harness.db,
    log,
    fallback,
    config: { APP_BASE_URL: 'http://localhost:3001', PUBLIC_BASE_URL: 'https://practice.example' },
    fetchImpl,
    ttlMs: 0,
  });
}

async function enableInbox(): Promise<void> {
  const envelope = core.encryptJson(
    { provider: 'twilio', accountSid: AC, authToken: 'token-12345', messagingServiceSid: MG },
    core.resolveKey(KMS_KEY),
  );
  await harness.db.execute(
    sql`UPDATE firm_settings SET sms_config_encrypted = ${envelope}, sms_inbox_enabled = true WHERE firm_id = ${seed.firmId}`,
  );
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  process.env['KMS_KEY'] = KMS_KEY;
  await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})`);
  twilioCalls = [];
  fallbackCalls = [];
  twilioReply = () => ({
    status: 201,
    json: { sid: 'SM100', status: 'accepted', num_segments: '1' },
  });
});

afterEach(async () => {
  await harness.close();
});

describe('SmsSendService', () => {
  it('uses the fallback provider when the inbox is not enabled', async () => {
    const r = await service().send({
      to: '+12025550199',
      body: 'hi',
      context: { kind: 'notification', subKind: 'invoice', firmId: seed.firmId },
    });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('legacy');
    expect(fallbackCalls).toHaveLength(1);
    expect(twilioCalls).toHaveLength(0);
    const rows = await harness.db.select().from(smsMessages);
    expect(rows).toHaveLength(0);
  });

  it('security codes always take the fallback path, even with the inbox on and an opted-out person', async () => {
    await enableInbox();
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Opted Out',
      mobile: '+12025550199',
    });
    await harness.db.update(persons).set({ smsOptOut: true }).where(eq(persons.id, personId));
    const r = await service().send({
      to: '+12025550199',
      body: 'code 123',
      context: { kind: 'security' },
    });
    expect(r.ok).toBe(true);
    expect(fallbackCalls).toHaveLength(1);
    expect(twilioCalls).toHaveLength(0);
  });

  it('inbox mode: writes conversation + message, sends via the Messaging Service, records sid/segments + notification_log', async () => {
    await enableInbox();
    const { lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId });
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Client',
      mobile: '(202) 555-0199',
    });
    await harness.db
      .update(persons)
      .set({ smsConsentAt: new Date(), smsConsentSource: 'verbal' })
      .where(eq(persons.id, personId));
    twilioReply = () => ({
      status: 201,
      json: { sid: 'SM100', status: 'accepted', num_segments: '2' },
    });
    const r = await service().send({
      to: '2025550199',
      body: 'Your appointment is tomorrow',
      templateKey: 'appointment_reminder',
      context: { kind: 'appointment_reminder', firmId: seed.firmId, clientId: seed.clientId },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe('inbox');
    expect(r.providerMessageId).toMatch(/^SM\d+$/);
    expect(r.numSegments).toBe(2);
    expect(twilioCalls[0]!.body).toContain(`MessagingServiceSid=${MG}`);
    expect(twilioCalls[0]!.body).toContain(
      'StatusCallback=https%3A%2F%2Fpractice.example%2Fapi%2Fsms%2Ftwilio%2Fstatus',
    );
    const [conv] = await harness.db.select().from(smsConversations);
    expect(conv!.lineId).toBe(lineId);
    expect(conv!.externalNumberE164).toBe('+12025550199');
    expect(conv!.personId).toBe(personId);
    expect(conv!.clientId).toBe(seed.clientId);
    expect(conv!.linkSource).toBe('reply_context');
    const [msg] = await harness.db.select().from(smsMessages);
    expect(msg!.direction).toBe('outbound');
    expect(msg!.providerMessageId).toMatch(/^SM\d+$/);
    expect(msg!.providerStatus).toBe('accepted');
    expect(msg!.numSegments).toBe(2);
    expect(msg!.contextKind).toBe('appointment_reminder');
    const logs = await harness.db.select().from(notificationLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.providerMessageId).toBe(msg!.providerMessageId);
    expect(logs[0]!.templateKey).toBe('appointment_reminder');
  });

  it('blocks opted-out people before calling Twilio', async () => {
    await enableInbox();
    await seedSmsLine(harness.db, { firmId: seed.firmId });
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Opted Out',
      mobile: '+12025550199',
    });
    await harness.db
      .update(persons)
      .set({ smsOptOut: true, smsConsentAt: new Date(), smsConsentSource: 'legacy' })
      .where(eq(persons.id, personId));
    const r = await service().send({
      to: '+12025550199',
      body: 'hi',
      context: { kind: 'notification', subKind: 'dunning', firmId: seed.firmId },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('opted_out');
    expect(r.personId).toBe(personId);
    expect(twilioCalls).toHaveLength(0);
    expect(await harness.db.select().from(smsMessages)).toHaveLength(0);
  });

  it('blocks outbound-initiated sends without consent, but not replies inside an inbound thread', async () => {
    await enableInbox();
    const { lineId, number } = await seedSmsLine(harness.db, { firmId: seed.firmId });
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'No Consent',
      mobile: '+12025550199',
    });
    const svc = service();
    const blocked = await svc.send({
      to: '+12025550199',
      body: 'first touch',
      context: { kind: 'manual', sentByUserId: seed.appUserId, firmId: seed.firmId },
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('no_consent');

    // Client texted first → replies are always allowed (D8a).
    const [conv] = await harness.db
      .insert(smsConversations)
      .values({
        firmId: seed.firmId,
        lineId,
        externalNumberE164: '+12025550199',
        personId,
        lastInboundAt: new Date(),
        lastMessageAt: new Date(),
      })
      .returning({ id: smsConversations.id });
    const reply = await svc.send({
      to: '+12025550199',
      body: 'sure!',
      context: {
        kind: 'manual',
        sentByUserId: seed.appUserId,
        firmId: seed.firmId,
        conversationId: conv!.id,
      },
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.conversationId).toBe(conv!.id);
    expect(twilioCalls[0]!.body).toContain(`To=%2B12025550199`);
    void number;

    // Kill switch off → outbound-initiated allowed too.
    await harness.db.execute(sql`UPDATE firm_settings SET sms_consent_enforced = false`);
    const allowed = await svc.send({
      to: '+12025550198',
      body: 'x',
      context: { kind: 'manual', sentByUserId: seed.appUserId, firmId: seed.firmId, personId },
    });
    expect(allowed.ok).toBe(true);
  });

  it('A2P unregistered blocks US long-code sends unless overridden', async () => {
    await enableInbox();
    await seedSmsLine(harness.db, { firmId: seed.firmId });
    await harness.db.execute(sql`UPDATE firm_settings SET sms_a2p_status = 'unregistered'`);
    const blocked = await service().send({
      to: '+12025550199',
      body: 'hi',
      context: { kind: 'notification', subKind: 'invoice', firmId: seed.firmId },
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('a2p_unregistered');
    await harness.db.execute(sql`UPDATE firm_settings SET sms_a2p_override_allow = true`);
    const ok = await service().send({
      to: '+12025550199',
      body: 'hi',
      context: { kind: 'notification', subKind: 'invoice', firmId: seed.firmId },
    });
    expect(ok.ok).toBe(true);
  });

  it('marks the person opted out on Twilio error 21610 and records the failure', async () => {
    await enableInbox();
    await seedSmsLine(harness.db, { firmId: seed.firmId });
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Stopped Elsewhere',
      mobile: '+12025550199',
    });
    await harness.db
      .update(persons)
      .set({ smsConsentAt: new Date(), smsConsentSource: 'legacy' })
      .where(eq(persons.id, personId));
    twilioReply = () => ({
      status: 400,
      json: { code: 21610, message: 'Attempt to send to unsubscribed recipient' },
    });
    const r = await service().send({
      to: '+12025550199',
      body: 'hi',
      context: { kind: 'notification', subKind: 'invoice', firmId: seed.firmId },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('opted_out');
    expect(r.retryable).toBe(false);
    const [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsOptOut).toBe(true);
    expect(p!.smsOptOutSource).toBe('provider_21610');
    const [msg] = await harness.db.select().from(smsMessages);
    expect(msg!.providerStatus).toBe('failed');
    expect(msg!.providerErrorCode).toBe(21610);
    const [log] = await harness.db.select().from(notificationLog);
    expect(log!.status).toBe('failed');
  });

  it('5xx is reported retryable and the message row stays for retry', async () => {
    await enableInbox();
    await seedSmsLine(harness.db, { firmId: seed.firmId });
    twilioReply = () => ({ status: 503, json: { message: 'busy' } });
    const r = await service().send({
      to: '+12025550199',
      body: 'hi',
      context: { kind: 'notification', subKind: 'invoice', firmId: seed.firmId },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('provider_error');
    expect(r.retryable).toBe(true);
    expect(r.messageId).toBeTruthy();
  });

  it('keeps an existing thread on its own line instead of the default line', async () => {
    await enableInbox();
    const { lineId: defaultLine } = await seedSmsLine(harness.db, {
      firmId: seed.firmId,
      number: '+12025550100',
    });
    const { lineId: otherLine } = await seedSmsLine(harness.db, {
      firmId: seed.firmId,
      number: '+12025550101',
      isDefault: false,
    });
    await harness.db.insert(smsConversations).values({
      firmId: seed.firmId,
      lineId: otherLine,
      externalNumberE164: '+12025550199',
      lastInboundAt: new Date(),
      lastMessageAt: new Date(),
      status: 'closed',
    });
    const r = await service().send({
      to: '+12025550199',
      body: 'reminder',
      context: { kind: 'notification', subKind: 'invoice', firmId: seed.firmId },
    });
    expect(r.ok).toBe(true);
    const convs = await harness.db.select().from(smsConversations);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.lineId).toBe(otherLine);
    expect(convs[0]!.status).toBe('open'); // outbound reopens a closed thread
    const [msg] = await harness.db.select().from(smsMessages);
    expect(msg!.fromE164).toBe('+12025550101');
    void defaultLine;
    const lines = await harness.db.select().from(smsLines);
    expect(lines).toHaveLength(2);
  });
});
