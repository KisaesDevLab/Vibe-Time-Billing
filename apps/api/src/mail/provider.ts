// SPDX-License-Identifier: Elastic-2.0
//
// Email provider abstraction (Q11). Console for dev (logs the message
// + link to stdout — used in tests and dev when MailHog isn't running),
// SMTP for the usual case, Postmark/Resend/SES for hosted.
//
// All four implementations share the same interface so app.ts swaps
// them based on MAIL_PROVIDER env.

export interface MailAttachment {
  /** Filename presented to the recipient (e.g. "statement.pdf"). */
  filename: string;
  /** Raw bytes. */
  content: Buffer;
  /** MIME type — defaults to application/octet-stream when omitted. */
  contentType?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  body: string; // plain text fallback
  /** Optional HTML body. When provided, mail clients (including MailHog
   *  in dev) render this version instead of the plain-text body, so
   *  long URLs stay clickable and unbroken across quoted-printable
   *  line wraps. */
  html?: string;
  /** Reply-To — defaults to the firm's support mailbox via the branding
   *  wrap so client replies land somewhere staffed, not the no-reply
   *  sender. Honored by SMTP, Postmark, Resend, EmailIt. */
  replyTo?: string;
  /** 0054 — file attachments. SMTP, console + EmailIt honor these;
   *  Postmark / Resend / SES drop attachments silently (extend
   *  per-provider when the firm actually uses one). */
  attachments?: MailAttachment[];
}

export interface MailProvider {
  id: 'console' | 'smtp' | 'postmark' | 'resend' | 'ses' | 'emailit';
  send(msg: MailMessage): Promise<{ ok: boolean; messageId?: string; error?: string }>;
}

import type { Logger } from 'pino';

export function createConsoleMailProvider(log: Logger): MailProvider {
  return {
    id: 'console',
    async send(msg) {
      log.info(
        {
          to: msg.to,
          subject: msg.subject,
          preview: msg.body.slice(0, 200),
          attachments: msg.attachments?.map((a) => a.filename) ?? [],
        },
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
        // Defensive log to help debug envelope failures — print what
        // we're handing to nodemailer (sans attachment bytes).
        log.info(
          {
            to: msg.to,
            from: opts.from,
            subject: msg.subject,
            attachmentCount: msg.attachments?.length ?? 0,
            attachmentFilenames: msg.attachments?.map((a) => a.filename) ?? [],
          },
          'smtp send begin',
        );
        const info = await transport.sendMail({
          from: opts.from,
          to: msg.to,
          subject: msg.subject,
          text: msg.body,
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.html ? { html: msg.html } : {}),
          ...(msg.attachments && msg.attachments.length > 0
            ? {
                attachments: msg.attachments.map((a) => ({
                  filename: a.filename,
                  content: a.content,
                  contentType: a.contentType ?? 'application/octet-stream',
                })),
              }
            : {}),
        });
        return { ok: true, messageId: info.messageId };
      } catch (err) {
        log.error({ err, to: msg.to, from: opts.from }, 'smtp send failed');
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
            ...(msg.replyTo ? { ReplyTo: msg.replyTo } : {}),
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

// P26 — EmailIt provider (https://emailit.com). Same shape as Resend
// — bearer token + JSON POST. Pulled in for the proposal addendum's
// §0.1 explicit "SMTP / Postmark / EmailIt" list. Migrated to API v2
// (v1 sunset Dec 2025): attachments are supported either inline
// (base64 `content`) or by reference (`url`, fetched by EmailIt's
// servers at send time). Tracking is forced off so open/click
// rewrites can't mangle magic links and other transactional URLs.
export interface EmailItOptions {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
  /**
   * Opt-in URL attachments (v2 `attachments[].url`): stash the bytes
   * somewhere publicly fetchable and return the absolute URL. EmailIt's
   * servers download at send time, so the URL must be reachable from the
   * public internet — leave unset (inline base64) for LAN-only
   * appliances. A stash failure falls back to inline for that
   * attachment rather than dropping it.
   */
  stashAttachmentUrl?: (att: MailAttachment) => string;
  /** Injectable for tests — the 429 retry back-off. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const EMAILIT_RETRY_DELAY_MS = 750;

export function createEmailItProvider(opts: EmailItOptions, log: Logger): MailProvider {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  function toAttachment(a: MailAttachment): Record<string, string> {
    if (opts.stashAttachmentUrl) {
      try {
        return { filename: a.filename, url: opts.stashAttachmentUrl(a) };
      } catch (err) {
        log.warn({ err, filename: a.filename }, 'emailit attachment stash failed; inlining');
      }
    }
    return {
      filename: a.filename,
      content: a.content.toString('base64'),
      content_type: a.contentType ?? 'application/octet-stream',
    };
  }
  return {
    id: 'emailit',
    async send(msg) {
      try {
        const body = JSON.stringify({
          from: opts.from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.body,
          html: msg.html,
          ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
          tracking: false,
          ...(msg.attachments && msg.attachments.length > 0
            ? { attachments: msg.attachments.map(toAttachment) }
            : {}),
        });
        const post = () =>
          fetchImpl('https://api.emailit.com/v2/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${opts.apiKey}`,
              'Content-Type': 'application/json',
            },
            body,
          });
        let res = await post();
        // Starter workspaces are limited to 2 msg/s — one short retry
        // keeps bulk loops (statements, mail-merge) from dropping sends.
        if (res.status === 429) {
          await sleep(EMAILIT_RETRY_DELAY_MS);
          res = await post();
        }
        const json = (await res.json().catch(() => ({}))) as {
          id?: string;
          message_id?: string;
          message?: string;
          error?: string;
        };
        if (!res.ok) {
          return { ok: false, error: json.message ?? json.error ?? `emailit ${res.status}` };
        }
        return { ok: true, messageId: json.id ?? json.message_id };
      } catch (err) {
        log.error({ err }, 'emailit send failed');
        return { ok: false, error: err instanceof Error ? err.message : 'emailit_failed' };
      }
    },
  };
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
            ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
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
