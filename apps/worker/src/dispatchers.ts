// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Minimal dispatchers for the worker realm. The full pluggable provider
// abstraction lives in apps/api/src/{mail,sms}; the worker only needs
// dunning + future autopay-failure notifications, so we inline a small
// SMTP/Postmark/Resend mail path and a Twilio/TextLink SMS path keyed off
// the same env vars apps/api uses. If the provider isn't configured the
// dispatcher is undefined and runDunningSweep silently no-ops the send.

import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';

import { crypto as core } from '@vibe/core';
import type { Database } from '@vibe/db';
import { firmSettings, firms } from '@vibe/db/schema';
import {
  wrapPlainTextEmail,
  wrapHtmlSnippet,
  isFullHtmlDocument,
  type EmailBranding,
} from '@vibe/core/notifications';
import { normalizePhone } from '@vibe/core/auth';

// Best-effort E.164 at the send boundary — most stored numbers omit the
// "+1" country code. Falls back to the raw string for non-US numbers.
function toE164(raw: string): string {
  return normalizePhone(raw) ?? raw;
}

export interface MailArgs {
  to: string;
  subject: string;
  body: string;
  html?: string;
  /** Raw .ics content attached as appointment.ics (calendar invites). */
  ics?: string;
}
export type MailDispatch = (args: MailArgs) => Promise<void>;
export type SmsDispatch = (args: { to: string; body: string }) => Promise<void>;
export type VoiceDispatch = (args: {
  to: string;
  script: string;
  confirmUrl?: string;
}) => Promise<void>;

const ICS_FILENAME = 'appointment.ics';
const ICS_CONTENT_TYPE = 'text/calendar; charset=utf-8; method=REQUEST';

// Give worker-originated emails (dunning, reminders, staged notifications) the
// same branded HTML header as the API's. Wraps a dispatch so it fills in `html`
// from firm branding when a caller didn't supply its own. Branding is cached
// briefly to avoid a DB hit per message.
export function withEmailBranding(
  dispatch: MailDispatch | undefined,
  db: Database | null,
): MailDispatch | undefined {
  if (!dispatch) return undefined;
  let cache: EmailBranding | null = null;
  let cachedAt = 0;
  async function branding(): Promise<EmailBranding> {
    const now = Date.now();
    if (cache && now - cachedAt < 60_000) return cache;
    if (!db) return ((cache = {}), (cachedAt = now), cache);
    try {
      const [firm] = await db.select({ id: firms.id }).from(firms).limit(1);
      if (!firm) return ((cache = {}), (cachedAt = now), cache);
      const [s] = await db
        .select({
          firmName: firmSettings.brandDisplayName,
          logoUrl: firmSettings.brandLogoUrl,
          accentColor: firmSettings.brandAccentColor,
          supportEmail: firmSettings.brandSupportEmail,
          supportPhone: firmSettings.brandSupportPhone,
        })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, firm.id))
        .limit(1);
      cache = s ?? {};
      cachedAt = now;
      return cache;
    } catch {
      return cache ?? {};
    }
  }
  return async (args) => {
    if (args.html && isFullHtmlDocument(args.html)) return dispatch(args);
    const b = await branding();
    const html = args.html
      ? wrapHtmlSnippet({ html: args.html, branding: b })
      : wrapPlainTextEmail({ text: args.body, branding: b });
    return dispatch({ ...args, html });
  };
}

// Normalized mail-provider config the worker's dispatch is built from —
// sourced either from env (buildMailDispatch) or the firm's DB-saved
// Admin → Messaging config (resolveFirmMailConfig).
export interface WorkerMailConfig {
  provider: string;
  from: string;
  postmarkToken?: string;
  resendKey?: string;
  emailitKey?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
}

export function buildMailDispatch(log: Logger): MailDispatch | undefined {
  return dispatchFromConfig(
    {
      provider: process.env['MAIL_PROVIDER'] ?? 'console',
      from: process.env['MAIL_FROM'] ?? 'no-reply@example.com',
      postmarkToken: process.env['MAIL_POSTMARK_TOKEN'],
      resendKey: process.env['MAIL_RESEND_API_KEY'],
      emailitKey: process.env['MAIL_EMAILIT_API_KEY'],
      smtpHost: process.env['MAIL_SMTP_HOST'],
      smtpPort: process.env['MAIL_SMTP_PORT'] ? Number(process.env['MAIL_SMTP_PORT']) : undefined,
      smtpSecure: process.env['MAIL_SMTP_SECURE'] === 'true',
      smtpUser: process.env['MAIL_SMTP_USER'],
      smtpPass: process.env['MAIL_SMTP_PASS'],
    },
    log,
  );
}

function dispatchFromConfig(cfg: WorkerMailConfig, log: Logger): MailDispatch | undefined {
  const provider = cfg.provider;
  const from = cfg.from;
  if (provider === 'postmark' && cfg.postmarkToken) {
    const token = cfg.postmarkToken;
    return async (args) => {
      const r = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': token!,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          From: from,
          To: args.to,
          Subject: args.subject,
          TextBody: args.body,
          ...(args.html ? { HtmlBody: args.html } : {}),
          ...(args.ics
            ? {
                Attachments: [
                  {
                    Name: ICS_FILENAME,
                    Content: Buffer.from(args.ics).toString('base64'),
                    ContentType: ICS_CONTENT_TYPE,
                  },
                ],
              }
            : {}),
        }),
      });
      if (!r.ok) throw new Error(`postmark_${r.status}`);
    };
  }
  if (provider === 'resend' && cfg.resendKey) {
    const key = cfg.resendKey;
    return async (args) => {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: args.to,
          subject: args.subject,
          text: args.body,
          ...(args.html ? { html: args.html } : {}),
          ...(args.ics
            ? {
                attachments: [
                  { filename: ICS_FILENAME, content: Buffer.from(args.ics).toString('base64') },
                ],
              }
            : {}),
        }),
      });
      if (!r.ok) throw new Error(`resend_${r.status}`);
    };
  }
  if (provider === 'emailit' && cfg.emailitKey) {
    const key = cfg.emailitKey;
    return async (args) => {
      // EmailIt API v2 (v1 sunset Dec 2025); `to` as an array, mirrors
      // createEmailItProvider. ICS goes as a base64 inline attachment and
      // tracking is forced off so link rewrites can't break invite URLs.
      const post = () =>
        fetch('https://api.emailit.com/v2/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from,
            to: [args.to],
            subject: args.subject,
            text: args.body,
            ...(args.html ? { html: args.html } : {}),
            tracking: false,
            ...(args.ics
              ? {
                  attachments: [
                    {
                      filename: ICS_FILENAME,
                      content: Buffer.from(args.ics).toString('base64'),
                      content_type: ICS_CONTENT_TYPE,
                    },
                  ],
                }
              : {}),
          }),
        });
      let r = await post();
      // Starter workspaces are capped at 2 msg/s — retry once so reminder
      // sweeps don't drop sends on a burst.
      if (r.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        r = await post();
      }
      if (!r.ok) throw new Error(`emailit_${r.status}`);
    };
  }
  if (provider === 'smtp' && cfg.smtpHost) {
    const host = cfg.smtpHost;
    const port = cfg.smtpPort ?? 1025;
    const secure = cfg.smtpSecure ?? false;
    const user = cfg.smtpUser;
    const pass = cfg.smtpPass;
    return async (args) => {
      const nodemailer = await import('nodemailer');
      const transport = nodemailer.default.createTransport({
        host,
        port,
        secure,
        auth: user && pass ? { user, pass } : undefined,
      });
      await transport.sendMail({
        from,
        to: args.to,
        subject: args.subject,
        text: args.body,
        ...(args.html ? { html: args.html } : {}),
        ...(args.ics
          ? {
              attachments: [
                { filename: ICS_FILENAME, content: args.ics, contentType: ICS_CONTENT_TYPE },
              ],
            }
          : {}),
      });
    };
  }
  log.info({ provider }, 'worker mail dispatcher disabled (no provider configured)');
  return undefined;
}

interface StoredEmailConfig {
  provider: 'smtp' | 'postmark' | 'resend' | 'ses' | 'emailit';
  from?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  token?: string;
  apiKey?: string;
}

// Read + decrypt the firm's Admin → Messaging email config (encrypted under
// KMS_KEY, same envelope the API writes) into a worker dispatch. Mirrors
// ../api sms-resolver: decrypts with @vibe/core directly. Returns undefined
// when there's no usable DB config so the caller keeps the env dispatch.
async function resolveFirmMailDispatch(
  db: Database,
  log: Logger,
): Promise<MailDispatch | undefined> {
  const [firm] = await db.select({ id: firms.id }).from(firms).limit(1);
  if (!firm) return undefined;
  const [row] = await db
    .select({ enc: firmSettings.mailConfigEncrypted })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firm.id))
    .limit(1);
  if (!row?.enc) return undefined; // no DB config → env fallback
  const keyRaw = process.env['KMS_KEY'];
  if (!keyRaw) {
    log.warn('mail config present but KMS_KEY unset; cannot decrypt');
    return undefined;
  }
  let cfg: StoredEmailConfig;
  try {
    cfg = core.decryptJson<StoredEmailConfig>(row.enc, core.resolveKey(keyRaw));
  } catch (err) {
    log.warn({ err }, 'mail config decrypt failed');
    return undefined;
  }
  if (!cfg.from || cfg.provider === 'ses') {
    // SES has no worker path yet; missing from-address is unusable.
    return undefined;
  }
  return dispatchFromConfig(
    {
      provider: cfg.provider,
      from: cfg.from,
      postmarkToken: cfg.token,
      resendKey: cfg.apiKey,
      emailitKey: cfg.apiKey,
      smtpHost: cfg.host,
      smtpPort: cfg.port,
      smtpSecure: cfg.secure,
      smtpUser: cfg.user,
      smtpPass: cfg.pass,
    },
    log,
  );
}

/**
 * Wrap the env-configured mail dispatch so every send first tries the firm's
 * DB-saved provider (Admin → Messaging) and falls back to the env dispatch
 * when none is configured. Mirrors withEmailBranding / the API's
 * wrapMailWithFirmConfig: resolution is cached briefly so an admin config
 * change takes effect within the TTL without a per-message decrypt.
 */
export function withFirmMailConfig(
  base: MailDispatch | undefined,
  db: Database | null,
  log: Logger,
): MailDispatch | undefined {
  if (!db) return base;
  let cached: MailDispatch | undefined;
  let cachedAt = 0;
  let resolvedOnce = false;
  async function resolve(): Promise<MailDispatch | undefined> {
    const now = Date.now();
    if (resolvedOnce && now - cachedAt < 60_000) return cached ?? base;
    try {
      cached = await resolveFirmMailDispatch(db!, log);
    } catch (err) {
      log.warn({ err }, 'firm mail dispatch resolve failed; using env fallback');
      cached = undefined;
    }
    cachedAt = now;
    resolvedOnce = true;
    return cached ?? base;
  }
  return async (args) => {
    const d = await resolve();
    if (!d) return; // no provider anywhere → silent no-op (same as env-undefined)
    await d(args);
  };
}

export function buildSmsDispatch(log: Logger): SmsDispatch | undefined {
  const provider = process.env['SMS_PROVIDER'] ?? 'console';
  if (
    provider === 'twilio' &&
    process.env['SMS_TWILIO_ACCOUNT_SID'] &&
    process.env['SMS_TWILIO_AUTH_TOKEN'] &&
    process.env['SMS_TWILIO_FROM']
  ) {
    const sid = process.env['SMS_TWILIO_ACCOUNT_SID']!;
    const token = process.env['SMS_TWILIO_AUTH_TOKEN']!;
    const from = process.env['SMS_TWILIO_FROM']!;
    return async (args) => {
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const body = new URLSearchParams({ From: from, To: toE164(args.to), Body: args.body });
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      if (!r.ok) throw new Error(`twilio_${r.status}`);
    };
  }
  if (provider === 'textlink' && process.env['SMS_TEXTLINK_API_KEY']) {
    const key = process.env['SMS_TEXTLINK_API_KEY']!;
    return async (args) => {
      // TextLink REST API — https://docs.textlinksms.com/api
      const r = await fetch('https://textlinksms.com/api/send-sms', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: toE164(args.to), text: args.body }),
      });
      const json = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!r.ok || json.ok === false) {
        throw new Error(json.message ?? `textlink_${r.status}`);
      }
    };
  }
  log.info({ provider }, 'worker sms dispatcher disabled (no provider configured)');
  return undefined;
}

/** XML-escape for inline TwiML <Say> content. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 0121 — automated voice reminder via Twilio. Places a call with inline TwiML
 * (no public callback URL needed for the prompt). When `confirmUrl` is set, a
 * <Gather> collects a press-1 confirmation and POSTs the digit to our webhook.
 * Reuses VOICE_TWILIO_* (may equal SMS creds; FROM must be voice-capable).
 */
export function buildVoiceDispatch(log: Logger): VoiceDispatch | undefined {
  const provider = process.env['VOICE_PROVIDER'] ?? 'console';
  if (
    provider === 'twilio' &&
    process.env['VOICE_TWILIO_ACCOUNT_SID'] &&
    process.env['VOICE_TWILIO_AUTH_TOKEN'] &&
    process.env['VOICE_TWILIO_FROM']
  ) {
    const sid = process.env['VOICE_TWILIO_ACCOUNT_SID']!;
    const token = process.env['VOICE_TWILIO_AUTH_TOKEN']!;
    const from = process.env['VOICE_TWILIO_FROM']!;
    return async (args) => {
      const say = xmlEscape(args.script);
      const twiml = args.confirmUrl
        ? `<Response><Gather numDigits="1" action="${xmlEscape(args.confirmUrl)}" method="POST"><Say>${say} Press 1 to confirm.</Say></Gather><Say>Goodbye.</Say></Response>`
        : `<Response><Say>${say}</Say></Response>`;
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const body = new URLSearchParams({ From: from, To: args.to, Twiml: twiml });
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      if (!r.ok) throw new Error(`twilio_voice_${r.status}`);
    };
  }
  if (provider === 'console') {
    return async (args) => {
      log.info({ to: args.to, script: args.script }, 'voice (console) reminder');
    };
  }
  log.info({ provider }, 'worker voice dispatcher disabled (no provider configured)');
  return undefined;
}
