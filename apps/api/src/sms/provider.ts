// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// SMS provider abstraction (Q16). TextLink (default per Vibe stack),
// Twilio, AWS SNS. Console fallback for dev.

import type { Logger } from 'pino';

export interface SmsMessage {
  to: string; // E.164
  body: string;
}

export interface SmsProvider {
  id: 'console' | 'textlink' | 'twilio' | 'sns';
  send(msg: SmsMessage): Promise<{ ok: boolean; providerMessageId?: string; error?: string }>;
}

export function createConsoleSmsProvider(log: Logger): SmsProvider {
  return {
    id: 'console',
    async send(msg) {
      log.info({ to: msg.to, body: msg.body }, 'sms (console)');
      return { ok: true, providerMessageId: `console_${Date.now()}` };
    },
  };
}

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  from: string;
  fetchImpl?: typeof fetch;
}

export function createTwilioSmsProvider(opts: TwilioOptions, log: Logger): SmsProvider {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  return {
    id: 'twilio',
    async send(msg) {
      try {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${opts.accountSid}/Messages.json`;
        const body = new URLSearchParams({ To: msg.to, From: opts.from, Body: msg.body });
        const auth = Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64');
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
        const res = await fetchImpl('https://api.textlink.com/v1/messages', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to: msg.to, body: msg.body }),
        });
        const json = (await res.json()) as { id?: string; error?: string };
        if (!res.ok) return { ok: false, error: json.error ?? `textlink ${res.status}` };
        return { ok: true, providerMessageId: json.id };
      } catch (err) {
        log.error({ err }, 'textlink send failed');
        return { ok: false, error: err instanceof Error ? err.message : 'textlink_failed' };
      }
    },
  };
}
