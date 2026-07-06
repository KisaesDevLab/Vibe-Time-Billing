// SPDX-License-Identifier: Elastic-2.0
//
// 0206 — shared voice-call placement engine. One choke point for every
// automated outbound call (appointment reminders, staged status
// notifications, admin test calls):
//
//   - resolves the firm's SEPARATE voice Twilio account from
//     firm_settings.voice_config_encrypted (env VOICE_TWILIO_* fallback)
//   - enforces the firm-local calling window (server-local clock — the
//     appliance runs where the firm does; single-firm by design)
//   - honors person.do_not_call (callers send the SMS version instead)
//   - renders inline TwiML with the configured <Say voice/language>,
//     an optional press-1 confirm, and an always-on press-9 opt-out
//     when the callee is a known person
//   - enables Twilio answering-machine detection and a status callback,
//     and logs every attempt to voice_call for outcome tracking +
//     voicemail / SMS-fallback bookkeeping.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettings, persons, voiceCalls } from '@vibe/db/schema';
import { crypto as core } from '@vibe/core';

// TYPE-ONLY import (erased at compile time). This module is shared with the
// worker, whose production image has no `zod` — do NOT import runtime values
// from messaging/config here (same constraint as messaging/sms-resolver).
import type { VoiceConfig } from '../messaging/config';
import { logger } from '../logger';

export interface PlaceVoiceCallArgs {
  firmId: string;
  /** Template/notification kind, e.g. 'appointment_reminder' or 'test'. */
  kind: string;
  to: string;
  /** Rendered script (variables already substituted). */
  script: string;
  /** SMS body to send if the call can't connect (busy/no-answer/failed). */
  fallbackSmsBody?: string;
  /** Per-template voice override; NULL → firm default voice. */
  voice?: string | null;
  personId?: string | null;
  clientId?: string | null;
  appointmentId?: string | null;
  stagedNotificationId?: string | null;
  /** Press-1 confirmation target (appointment RSVP). */
  confirmUrl?: string;
  /** Public app base URL — for the status callback + press-9 gather. */
  publicBaseUrl?: string;
  /** Admin test calls skip the window + opt-out gates. */
  bypassGates?: boolean;
  /** Try a proposed (unsaved) config — Admin test-before-save. */
  configOverride?: VoiceConfig;
}

export type PlaceVoiceCallResult =
  | { ok: true; voiceCallId: string; callSid: string }
  | {
      ok: false;
      code: 'not_configured' | 'outside_window' | 'do_not_call' | 'invalid_number' | 'call_failed';
      voiceCallId?: string;
      detail?: string;
    };

function toE164(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Resolve the firm's voice config: DB first, env VOICE_TWILIO_* fallback.
 *  Decrypts zod-free (KMS_KEY + @vibe/core AES envelope, mirroring
 *  sms-resolver) so the worker can share this module. */
export async function resolveFirmVoiceConfig(
  db: Database,
  firmId: string,
): Promise<VoiceConfig | null> {
  const [row] = await db
    .select({ enc: firmSettings.voiceConfigEncrypted })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  if (row?.enc) {
    const keyRaw = process.env['KMS_KEY'];
    if (!keyRaw) {
      logger.warn({ firmId }, 'voice config present but KMS_KEY unset; cannot decrypt');
      return null;
    }
    try {
      const raw = core.decryptJson<Partial<VoiceConfig>>(row.enc, core.resolveKey(keyRaw));
      if (!raw.accountSid || !raw.authToken || !raw.from) return null;
      return {
        provider: 'twilio',
        from: raw.from,
        accountSid: raw.accountSid,
        authToken: raw.authToken,
        defaultVoice: raw.defaultVoice ?? 'Polly.Joanna',
        language: raw.language ?? 'en-US',
        windowStart: raw.windowStart ?? '09:00',
        windowEnd: raw.windowEnd ?? '20:00',
      };
    } catch (err) {
      logger.warn({ err, firmId }, 'voice config decrypt failed');
      return null;
    }
  }
  const sid = process.env['VOICE_TWILIO_ACCOUNT_SID'];
  const token = process.env['VOICE_TWILIO_AUTH_TOKEN'];
  const from = process.env['VOICE_TWILIO_FROM'];
  if (sid && token && from) {
    return {
      provider: 'twilio',
      from,
      accountSid: sid,
      authToken: token,
      defaultVoice: process.env['VOICE_TWILIO_VOICE'] ?? 'Polly.Joanna',
      language: process.env['VOICE_TWILIO_LANGUAGE'] ?? 'en-US',
      windowStart: '09:00',
      windowEnd: '20:00',
    };
  }
  return null;
}

/** Is the (server-local) clock inside the configured calling window?
 *  Handles overnight windows (e.g. 20:00–09:00) too. */
export function withinCallWindow(
  cfg: Pick<VoiceConfig, 'windowStart' | 'windowEnd'>,
  now: Date = new Date(),
): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = cfg.windowStart.split(':').map(Number);
  const [eh, em] = cfg.windowEnd.split(':').map(Number);
  const start = sh! * 60 + sm!;
  const end = eh! * 60 + em!;
  if (start === end) return true; // degenerate config → always open
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end; // overnight window
}

/** Milliseconds until the calling window next opens (0 when already open). */
export function msUntilCallWindow(
  cfg: Pick<VoiceConfig, 'windowStart' | 'windowEnd'>,
  now: Date = new Date(),
): number {
  if (withinCallWindow(cfg, now)) return 0;
  const [sh, sm] = cfg.windowStart.split(':').map(Number);
  const next = new Date(now);
  next.setHours(sh!, sm!, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export async function placeVoiceCall(
  db: Database,
  args: PlaceVoiceCallArgs,
): Promise<PlaceVoiceCallResult> {
  const cfg = args.configOverride ?? (await resolveFirmVoiceConfig(db, args.firmId));
  if (!cfg) return { ok: false, code: 'not_configured' };

  if (!args.bypassGates && !withinCallWindow(cfg)) {
    // No row is written — callers retry when the window opens.
    return { ok: false, code: 'outside_window' };
  }

  if (!args.bypassGates && args.personId) {
    const [p] = await db
      .select({ doNotCall: persons.doNotCall })
      .from(persons)
      .where(eq(persons.id, args.personId))
      .limit(1);
    if (p?.doNotCall) {
      await db
        .insert(voiceCalls)
        .values({
          firmId: args.firmId,
          kind: args.kind,
          toNumber: args.to,
          personId: args.personId,
          clientId: args.clientId ?? null,
          appointmentId: args.appointmentId ?? null,
          stagedNotificationId: args.stagedNotificationId ?? null,
          script: args.script,
          fallbackSmsBody: args.fallbackSmsBody ?? null,
          status: 'opted_out',
          completedAt: new Date(),
        })
        .catch(() => undefined);
      return { ok: false, code: 'do_not_call' };
    }
  }

  const to = toE164(args.to);
  if (!to) return { ok: false, code: 'invalid_number', detail: args.to };

  const [row] = await db
    .insert(voiceCalls)
    .values({
      firmId: args.firmId,
      kind: args.kind,
      toNumber: to,
      personId: args.personId ?? null,
      clientId: args.clientId ?? null,
      appointmentId: args.appointmentId ?? null,
      stagedNotificationId: args.stagedNotificationId ?? null,
      script: args.script,
      fallbackSmsBody: args.fallbackSmsBody ?? null,
      voice: args.voice ?? cfg.defaultVoice,
    })
    .returning({ id: voiceCalls.id });
  const voiceCallId = row!.id;

  // TwiML: configured voice throughout; press-1 confirm when the caller
  // supplied a confirm URL; press-9 opt-out whenever we know the person.
  const voice = args.voice || cfg.defaultVoice;
  const sayAttrs = `voice="${xmlEscape(voice)}" language="${xmlEscape(cfg.language)}"`;
  const say = xmlEscape(args.script);
  const prompts: string[] = [];
  if (args.confirmUrl) prompts.push('Press 1 to confirm.');
  const gatherBase = args.publicBaseUrl
    ? `${args.publicBaseUrl.replace(/\/$/, '')}/api/public/appointments/twilio/voice-gather`
    : null;
  const canOptOut = Boolean(args.personId && gatherBase);
  if (canOptOut) prompts.push('Press 9 to stop automated calls.');
  const gatherParams = new URLSearchParams();
  if (args.appointmentId) gatherParams.set('a', args.appointmentId);
  if (args.personId) gatherParams.set('p', args.personId);
  gatherParams.set('vc', voiceCallId);
  // Prefer the caller-supplied confirm URL (it carries the contact id the
  // press-1 handler needs), enriched with the person + log-row ids so the
  // press-9 handler can flag the person and mark this call opted-out;
  // otherwise the generic gather endpoint.
  let gatherUrl: string | null = null;
  if (args.confirmUrl) {
    const sep = args.confirmUrl.includes('?') ? '&' : '?';
    const extra = new URLSearchParams();
    if (args.personId) extra.set('p', args.personId);
    extra.set('vc', voiceCallId);
    gatherUrl = `${args.confirmUrl}${sep}${extra}`;
  } else if (gatherBase) {
    gatherUrl = `${gatherBase}?${gatherParams}`;
  }
  const fullSay = `${say} ${prompts.map(xmlEscape).join(' ')}`.trim();
  const twiml =
    gatherUrl && prompts.length > 0
      ? `<Response><Gather numDigits="1" action="${xmlEscape(gatherUrl)}" method="POST"><Say ${sayAttrs}>${fullSay}</Say></Gather><Say ${sayAttrs}>Goodbye.</Say></Response>`
      : `<Response><Say ${sayAttrs}>${say}</Say></Response>`;

  const body = new URLSearchParams({ From: cfg.from, To: to, Twiml: twiml });
  // Answering-machine detection: with inline TwiML the message still plays
  // to voicemail (the point of "leave the message"); AnsweredBy on the
  // status callback tells us machine vs human for the outcome log.
  body.set('MachineDetection', 'Enable');
  if (args.publicBaseUrl) {
    body.set(
      'StatusCallback',
      `${args.publicBaseUrl.replace(/\/$/, '')}/api/public/appointments/twilio/voice-status?vc=${voiceCallId}`,
    );
    body.append('StatusCallbackEvent', 'completed');
  }

  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Calls.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );
    if (!r.ok) {
      const detail = `twilio_voice_${r.status}`;
      await db
        .update(voiceCalls)
        .set({ status: 'failed', error: detail, completedAt: new Date() })
        .where(eq(voiceCalls.id, voiceCallId));
      return { ok: false, code: 'call_failed', voiceCallId, detail };
    }
    const payload = (await r.json().catch(() => ({}))) as { sid?: string };
    await db
      .update(voiceCalls)
      .set({ status: 'placed', providerCallSid: payload.sid ?? null, placedAt: new Date() })
      .where(eq(voiceCalls.id, voiceCallId));
    return { ok: true, voiceCallId, callSid: payload.sid ?? '' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'fetch_failed';
    await db
      .update(voiceCalls)
      .set({ status: 'failed', error: detail, completedAt: new Date() })
      .where(eq(voiceCalls.id, voiceCallId));
    return { ok: false, code: 'call_failed', voiceCallId, detail };
  }
}
