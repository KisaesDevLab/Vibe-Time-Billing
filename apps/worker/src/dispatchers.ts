// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Minimal dispatchers for the worker realm. The full pluggable provider
// abstraction lives in apps/api/src/{mail,sms}; the worker only needs
// dunning + future autopay-failure notifications, so we inline a small
// SMTP/Postmark/Resend mail path and a Twilio/TextLink SMS path keyed off
// the same env vars apps/api uses. If the provider isn't configured the
// dispatcher is undefined and runDunningSweep silently no-ops the send.

import type { Logger } from 'pino';

export type MailDispatch = (args: { to: string; subject: string; body: string }) => Promise<void>;
export type SmsDispatch = (args: { to: string; body: string }) => Promise<void>;

export async function buildMailDispatch(log: Logger): Promise<MailDispatch | undefined> {
  const provider = process.env['MAIL_PROVIDER'] ?? 'console';
  const from = process.env['MAIL_FROM'] ?? 'no-reply@example.com';
  if (provider === 'postmark' && process.env['MAIL_POSTMARK_TOKEN']) {
    const token = process.env['MAIL_POSTMARK_TOKEN'];
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
        }),
      });
      if (!r.ok) throw new Error(`postmark_${r.status}`);
    };
  }
  if (provider === 'resend' && process.env['MAIL_RESEND_API_KEY']) {
    const key = process.env['MAIL_RESEND_API_KEY'];
    return async (args) => {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: args.to, subject: args.subject, text: args.body }),
      });
      if (!r.ok) throw new Error(`resend_${r.status}`);
    };
  }
  if (provider === 'smtp' && process.env['MAIL_SMTP_HOST']) {
    // @ts-expect-error nodemailer is an optional runtime dependency.
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.default.createTransport({
      host: process.env['MAIL_SMTP_HOST'],
      port: Number(process.env['MAIL_SMTP_PORT'] ?? 1025),
      secure: process.env['MAIL_SMTP_SECURE'] === 'true',
      auth:
        process.env['MAIL_SMTP_USER'] && process.env['MAIL_SMTP_PASS']
          ? { user: process.env['MAIL_SMTP_USER'], pass: process.env['MAIL_SMTP_PASS'] }
          : undefined,
    });
    return async (args) => {
      await transport.sendMail({ from, to: args.to, subject: args.subject, text: args.body });
    };
  }
  log.info({ provider }, 'worker mail dispatcher disabled (no provider configured)');
  return undefined;
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
      const body = new URLSearchParams({ From: from, To: args.to, Body: args.body });
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
      const r = await fetch('https://api.textlink.io/v1/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: args.to, body: args.body }),
      });
      if (!r.ok) throw new Error(`textlink_${r.status}`);
    };
  }
  log.info({ provider }, 'worker sms dispatcher disabled (no provider configured)');
  return undefined;
}
