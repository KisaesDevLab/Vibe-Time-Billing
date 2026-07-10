// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0206 — configurable voice calls. Covers the shared placement engine
// (TwiML voice/language, press prompts, machine detection, gates, the
// voice_call outcome log), the calling-window math, the press-9 opt-out
// webhook, and the status callback's outcome mapping.

import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { persons, voiceCalls } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { createAppointmentTwilioRouter } from '../appointments/twilio-routes';
import { msUntilCallWindow, placeVoiceCall, withinCallWindow } from '../voice/place-call';
import type { VoiceConfig } from '../messaging/config';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const TOKEN = 'test-voice-token';
const BASE = 'https://test.example';
const MOUNT = '/api/public/appointments/twilio';

const fakeRedis = new Proxy(
  {},
  {
    get() {
      return async () => {
        throw new Error('no-redis'); // rate-limiter fails open
      };
    },
  },
) as unknown as Redis;

function webhookApp(): express.Express {
  const a = express();
  a.use(
    MOUNT,
    createAppointmentTwilioRouter({
      db: harness.db,
      redis: fakeRedis,
      baseUrl: BASE,
      authTokens: [TOKEN],
    }),
  );
  return a;
}

function sign(fullUrl: string, params: Record<string, string>): string {
  let data = fullUrl;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return crypto.createHmac('sha1', TOKEN).update(data, 'utf8').digest('base64');
}

/** Always-open window (start === end is treated as 24h). */
function openConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    provider: 'twilio',
    from: '+15550000000',
    accountSid: 'ACtest12345',
    authToken: TOKEN,
    defaultVoice: 'Polly.Joanna',
    language: 'en-US',
    windowStart: '00:00',
    windowEnd: '00:00',
    ...overrides,
  };
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
  vi.unstubAllGlobals();
});

describe('calling window math', () => {
  const cfg = { windowStart: '09:00', windowEnd: '20:00' };
  it('open during the day, closed at night', () => {
    expect(withinCallWindow(cfg, new Date('2026-07-06T12:00:00'))).toBe(true);
    expect(withinCallWindow(cfg, new Date('2026-07-06T08:59:00'))).toBe(false);
    expect(withinCallWindow(cfg, new Date('2026-07-06T20:00:00'))).toBe(false);
  });
  it('handles overnight windows', () => {
    const night = { windowStart: '20:00', windowEnd: '09:00' };
    expect(withinCallWindow(night, new Date('2026-07-06T22:00:00'))).toBe(true);
    expect(withinCallWindow(night, new Date('2026-07-06T12:00:00'))).toBe(false);
  });
  it('msUntilCallWindow is 0 when open, positive when closed', () => {
    expect(msUntilCallWindow(cfg, new Date('2026-07-06T12:00:00'))).toBe(0);
    const ms = msUntilCallWindow(cfg, new Date('2026-07-06T21:00:00'));
    // 21:00 → next 09:00 is 12 hours away.
    expect(ms).toBe(12 * 3600 * 1000);
  });
});

describe('placeVoiceCall', () => {
  it('places a call with the configured voice, prompts, AMD, and logs the row', async () => {
    let captured: URLSearchParams | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: URLSearchParams }) => {
        captured = init.body;
        return {
          ok: true,
          json: async () => ({ sid: 'CA123' }),
        } as unknown as Response;
      }),
    );
    const c = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Callee',
      email: 'callee@example.com',
      mobile: '+15551239999',
    });
    const result = await placeVoiceCall(harness.db, {
      firmId: seed.firmId,
      kind: 'appointment_reminder',
      to: '+15551239999',
      script: 'Hello. Your appointment is tomorrow.',
      fallbackSmsBody: 'Reminder: appointment tomorrow.',
      voice: 'Polly.Matthew',
      personId: c.personId,
      clientId: seed.clientId,
      confirmUrl: `${BASE}${MOUNT}/voice-gather?a=00000000-0000-0000-0000-000000000001&c=${c.contactId}`,
      publicBaseUrl: BASE,
      configOverride: openConfig(),
    });
    expect(result.ok).toBe(true);
    const body = captured! as URLSearchParams;
    const twiml = body.get('Twiml')!;
    expect(twiml).toContain('voice="Polly.Matthew"');
    expect(twiml).toContain('language="en-US"');
    expect(twiml).toContain('Press 1 to confirm.');
    expect(twiml).toContain('Press 9 to stop automated calls.');
    expect(body.get('MachineDetection')).toBe('Enable');
    expect(body.get('StatusCallback')).toContain('/voice-status?vc=');
    // Gather action carries the person + log-row ids for press-9.
    expect(twiml).toContain(`p=${c.personId}`);

    const [row] = await harness.db.select().from(voiceCalls);
    expect(row!.status).toBe('placed');
    expect(row!.providerCallSid).toBe('CA123');
    expect(row!.voice).toBe('Polly.Matthew');
    expect(row!.fallbackSmsBody).toBe('Reminder: appointment tomorrow.');
  });

  it('refuses outside the calling window without logging a row', async () => {
    const now = new Date();
    const fmt = (h: number): string => `${String(h % 24).padStart(2, '0')}:00`;
    // A one-hour window starting two hours from now → currently closed.
    const cfg = openConfig({
      windowStart: fmt(now.getHours() + 2),
      windowEnd: fmt(now.getHours() + 3),
    });
    const result = await placeVoiceCall(harness.db, {
      firmId: seed.firmId,
      kind: 'appointment_reminder',
      to: '+15551239999',
      script: 'Hi.',
      configOverride: cfg,
    });
    expect(result).toMatchObject({ ok: false, code: 'outside_window' });
    expect(await harness.db.select().from(voiceCalls)).toHaveLength(0);
  });

  it('honors do-not-call: logs opted_out and never dials', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const c = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'No Calls',
      email: 'nocalls@example.com',
      mobile: '+15551238888',
    });
    await harness.db.update(persons).set({ doNotCall: true }).where(eq(persons.id, c.personId));
    const result = await placeVoiceCall(harness.db, {
      firmId: seed.firmId,
      kind: 'appointment_reminder',
      to: '+15551238888',
      script: 'Hi.',
      personId: c.personId,
      configOverride: openConfig(),
    });
    expect(result).toMatchObject({ ok: false, code: 'do_not_call' });
    expect(fetchSpy).not.toHaveBeenCalled();
    const [row] = await harness.db.select().from(voiceCalls);
    expect(row!.status).toBe('opted_out');
  });
});

describe('press-9 opt-out webhook', () => {
  it('sets person.do_not_call and marks the call row opted_out', async () => {
    const c = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Opting Out',
      email: 'optout@example.com',
      mobile: '+15551237777',
    });
    const [vc] = await harness.db
      .insert(voiceCalls)
      .values({
        firmId: seed.firmId,
        kind: 'appointment_reminder',
        toNumber: '+15551237777',
        personId: c.personId,
        script: 'Hi.',
        status: 'placed',
      })
      .returning({ id: voiceCalls.id });
    const path = `${MOUNT}/voice-gather?p=${c.personId}&vc=${vc!.id}`;
    const params = { Digits: '9', CallSid: 'CA9' };
    const res = await request(webhookApp())
      .post(path)
      .set('X-Twilio-Signature', sign(`${BASE}${path}`, params))
      .type('form')
      .send(params);
    expect(res.status).toBe(200);
    expect(res.text).toContain('no longer receive automated calls');
    const [p] = await harness.db
      .select({ dnc: persons.doNotCall })
      .from(persons)
      .where(eq(persons.id, c.personId));
    expect(p!.dnc).toBe(true);
    const [row] = await harness.db
      .select({ status: voiceCalls.status })
      .from(voiceCalls)
      .where(eq(voiceCalls.id, vc!.id));
    expect(row!.status).toBe('opted_out');
  });
});

describe('voice status callback', () => {
  async function seedCall(): Promise<string> {
    const [vc] = await harness.db
      .insert(voiceCalls)
      .values({
        firmId: seed.firmId,
        kind: 'appointment_reminder',
        toNumber: '+15551236666',
        script: 'Hi.',
        fallbackSmsBody: 'Reminder text.',
        status: 'placed',
      })
      .returning({ id: voiceCalls.id });
    return vc!.id;
  }

  async function postStatus(vcId: string, body: Record<string, string>): Promise<request.Response> {
    const path = `${MOUNT}/voice-status?vc=${vcId}`;
    return request(webhookApp())
      .post(path)
      .set('X-Twilio-Signature', sign(`${BASE}${path}`, body))
      .type('form')
      .send(body);
  }

  it('maps completed + machine to voicemail', async () => {
    const vcId = await seedCall();
    const res = await postStatus(vcId, { CallStatus: 'completed', AnsweredBy: 'machine_start' });
    expect(res.status).toBe(204);
    // The handler acks immediately and finishes async — poll briefly.
    await vi.waitFor(async () => {
      const [row] = await harness.db
        .select({ status: voiceCalls.status })
        .from(voiceCalls)
        .where(eq(voiceCalls.id, vcId));
      expect(row!.status).toBe('voicemail');
    });
  });

  it('maps busy to busy (fallback SMS skipped without a provider, flag stays false)', async () => {
    const vcId = await seedCall();
    await postStatus(vcId, { CallStatus: 'busy' });
    await vi.waitFor(async () => {
      const [row] = await harness.db
        .select({ status: voiceCalls.status, fb: voiceCalls.fallbackSmsSent })
        .from(voiceCalls)
        .where(eq(voiceCalls.id, vcId));
      expect(row!.status).toBe('busy');
      expect(row!.fb).toBe(false);
    });
  });
});
