// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Build a live MailProvider / SmsProvider from a validated config object.
// Used by both the dispatcher (when reading firm settings) and the
// test-send endpoint (when validating un-saved credentials).

import type { Logger } from 'pino';

import {
  createEmailItProvider,
  createPostmarkProvider,
  createResendProvider,
  createSmtpMailProvider,
  type MailProvider,
} from '../mail/provider';
import {
  createTextLinkSmsProvider,
  createTwilioSmsProvider,
  type SmsProvider,
} from '../sms/provider';
import type { EmailConfig, SmsConfig } from './config';

export function buildMailProvider(cfg: EmailConfig, log: Logger): MailProvider {
  switch (cfg.provider) {
    case 'smtp':
      return createSmtpMailProvider(
        {
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure ?? false,
          user: cfg.user,
          pass: cfg.pass,
          from: cfg.from,
        },
        log,
      );
    case 'postmark':
      return createPostmarkProvider({ token: cfg.token, from: cfg.from }, log);
    case 'resend':
      return createResendProvider({ apiKey: cfg.apiKey, from: cfg.from }, log);
    case 'emailit':
      return createEmailItProvider({ apiKey: cfg.apiKey, from: cfg.from }, log);
    case 'ses':
      // SES path not yet wired through a provider helper. For now, error
      // so the admin UI surfaces the gap honestly rather than silently
      // sending nothing.
      throw new Error('SES provider not yet implemented');
  }
}

export function buildSmsProvider(cfg: SmsConfig, log: Logger): SmsProvider {
  switch (cfg.provider) {
    case 'textlink':
      return createTextLinkSmsProvider({ apiKey: cfg.apiKey }, log);
    case 'twilio':
      return createTwilioSmsProvider(
        { accountSid: cfg.accountSid, authToken: cfg.authToken, from: cfg.from },
        log,
      );
    case 'sns':
      throw new Error('SNS provider not yet implemented');
  }
}
