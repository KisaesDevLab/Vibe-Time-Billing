// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Email provider abstraction (Q11). Console for dev (logs the message
// + link to stdout — used in tests and dev when MailHog isn't running),
// SMTP for the usual case, Postmark/Resend/SES for hosted.
//
// All four implementations share the same interface so app.ts swaps
// them based on MAIL_PROVIDER env.

export interface MailMessage {
  to: string;
  subject: string;
  body: string; // plain text fallback
  /** Optional HTML body. When provided, mail clients (including MailHog
   *  in dev) render this version instead of the plain-text body, so
   *  long URLs stay clickable and unbroken across quoted-printable
   *  line wraps. */
  html?: string;
}

export interface MailProvider {
  id: 'console' | 'smtp' | 'postmark' | 'resend' | 'ses';
  send(msg: MailMessage): Promise<{ ok: boolean; messageId?: string; error?: string }>;
}

import type { Logger } from 'pino';

export function createConsoleMailProvider(log: Logger): MailProvider {
  return {
    id: 'console',
    async send(msg) {
      log.info(
        { to: msg.to, subject: msg.subject, preview: msg.body.slice(0, 200) },
        'mail (console)',
      );
      return { ok: true, messageId: `console_${Date.now()}` };
    },
  };
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export function createSmtpMailProvider(opts: SmtpOptions, log: Logger): MailProvider {
  return {
    id: 'smtp',
    async send(msg) {
      // Use dynamic import so dev environments without nodemailer still boot.
      try {
        const nodemailer = await import('nodemailer');
        const transport = nodemailer.default.createTransport({
          host: opts.host,
          port: opts.port,
          secure: opts.secure ?? false,
          auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
        });
        const info = await transport.sendMail({
          from: opts.from,
          to: msg.to,
          subject: msg.subject,
          text: msg.body,
          ...(msg.html ? { html: msg.html } : {}),
        });
        return { ok: true, messageId: info.messageId };
      } catch (err) {
        log.error({ err }, 'smtp send failed');
        return { ok: false, error: err instanceof Error ? err.message : 'smtp_failed' };
      }
    },
  };
}

export interface PostmarkOptions {
  token: string;
  from: string;
  fetchImpl?: typeof fetch;
}

export function createPostmarkProvider(opts: PostmarkOptions, log: Logger): MailProvider {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  return {
    id: 'postmark',
    async send(msg) {
      try {
        const res = await fetchImpl('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Postmark-Server-Token': opts.token,
          },
          body: JSON.stringify({
            From: opts.from,
            To: msg.to,
            Subject: msg.subject,
            TextBody: msg.body,
          }),
        });
        const json = (await res.json()) as { MessageID?: string; Message?: string };
        if (!res.ok) return { ok: false, error: json.Message ?? `postmark ${res.status}` };
        return { ok: true, messageId: json.MessageID };
      } catch (err) {
        log.error({ err }, 'postmark send failed');
        return { ok: false, error: err instanceof Error ? err.message : 'postmark_failed' };
      }
    },
  };
}

export interface ResendOptions {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
}

export function createResendProvider(opts: ResendOptions, log: Logger): MailProvider {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  return {
    id: 'resend',
    async send(msg) {
      try {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: opts.from,
            to: msg.to,
            subject: msg.subject,
            text: msg.body,
          }),
        });
        const json = (await res.json()) as { id?: string; message?: string };
        if (!res.ok) return { ok: false, error: json.message ?? `resend ${res.status}` };
        return { ok: true, messageId: json.id };
      } catch (err) {
        log.error({ err }, 'resend send failed');
        return { ok: false, error: err instanceof Error ? err.message : 'resend_failed' };
      }
    },
  };
}
