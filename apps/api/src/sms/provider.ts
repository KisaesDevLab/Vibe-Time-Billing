// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// SMS provider abstraction (Q16). TextLink (default per Vibe stack),
// Twilio, AWS SNS. Console fallback for dev.

import type { Logger } from 'pino';

import { normalizePhone } from '@vibe/core/auth';

export interface SmsMessage {
  to: string; // E.164
  body: string;
}

// Best-effort E.164 at the send boundary. Most stored numbers omit the
// country code (e.g. "3125550148" or "(312) 555-0148"); normalizePhone
// prefixes "+1" for US 10/11-digit numbers. Fall back to the raw string
// if it isn't parseable — it may be a valid non-US number the provider
// can still handle (or will reject itself).
function toE164(raw: string): string {
  return normalizePhone(raw) ?? raw;
}

export interface SmsProvider {
  id: 'console' | 'textlink' | 'twilio' | 'sns';
  send(msg: SmsMessage): Promise<{ ok: boolean; providerMessageId?: string; error?: string }>;
}

export function createConsoleSmsProvider(log: Logger): SmsProvider {
  return {
    id: 'console',
    async send(msg) {
      log.info({ to: toE164(msg.to), body: msg.body }, 'sms (console)');
      return { ok: true, providerMessageId: `console_${Date.now()}` };
    },
  };
}

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** Raw sender. Optional once a Messaging Service is configured. */
  from?: string;
  /** 0233 — when set, sends go through the Messaging Service (Twilio picks
   *  the number, applies Advanced Opt-Out, queues for rate limits). */
  messagingServiceSid?: string;
  /** Optional REST auth pair (SK…/secret); falls back to SID:AuthToken. */
  apiKeySid?: string;
  apiKeySecret?: string;
  fetchImpl?: typeof fetch;
}

export function createTwilioSmsProvider(opts: TwilioOptions, log: Logger): SmsProvider {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  return {
    id: 'twilio',
    async send(msg) {
      try {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${opts.accountSid}/Messages.json`;
        const body = new URLSearchParams({ To: toE164(msg.to), Body: msg.body });
        if (opts.messagingServiceSid) body.set('MessagingServiceSid', opts.messagingServiceSid);
        else if (opts.from) body.set('From', opts.from);
        else return { ok: false, error: 'twilio: no From number or Messaging Service configured' };
        const user = opts.apiKeySid && opts.apiKeySecret ? opts.apiKeySid : opts.accountSid;
        const pass = opts.apiKeySid && opts.apiKeySecret ? opts.apiKeySecret : opts.authToken;
        const auth = Buffer.from(`${user}:${pass}`).toString('base64');
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        });
        const json = (await res.json()) as { sid?: string; message?: string };
        if (!res.ok) return { ok: false, error: json.message ?? `twilio ${res.status}` };
        return { ok: true, providerMessageId: json.sid };
      } catch (err) {
        log.error({ err }, 'twilio send failed');
        return { ok: false, error: err instanceof Error ? err.message : 'twilio_failed' };
      }
    },
  };
}

export interface TextLinkOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export function createTextLinkSmsProvider(opts: TextLinkOptions, log: Logger): SmsProvider {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  return {
    id: 'textlink',
    async send(msg) {
      try {
        // TextLink REST API — https://docs.textlinksms.com/api
        const res = await fetchImpl('https://textlinksms.com/api/send-sms', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ phone_number: toE164(msg.to), text: msg.body }),
        });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
        // TextLink returns HTTP 200 with { ok: false, message } on logical
        // failures (e.g. bad key), so check the body, not just res.ok.
        if (!res.ok || json.ok === false) {
          return { ok: false, error: json.message ?? `textlink ${res.status}` };
        }
        return { ok: true };
      } catch (err) {
        log.error({ err }, 'textlink send failed');
        return { ok: false, error: err instanceof Error ? err.message : 'textlink_failed' };
      }
    },
  };
}
