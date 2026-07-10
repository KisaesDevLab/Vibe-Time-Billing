// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Messaging provider config — shape definitions, validation, and on-disk
// encryption. The DB column stores the v1:<iv>:<ct>:<tag> envelope; this
// module is the only place that decrypts.

import { z } from 'zod';
import { crypto as core } from '@vibe/core';

import { loadConfig } from '../config';

// ----- Email -----

export const EmailProviderId = z.enum(['smtp', 'postmark', 'resend', 'ses', 'emailit']);
export type EmailProviderId = z.infer<typeof EmailProviderId>;

const SmtpConfig = z.object({
  provider: z.literal('smtp'),
  from: z.string().min(3).max(254),
  host: z.string().min(1).max(255),
  port: z.number().int().positive(),
  secure: z.boolean().optional(),
  user: z.string().max(255).optional(),
  pass: z.string().max(1024).optional(),
});

const PostmarkConfig = z.object({
  provider: z.literal('postmark'),
  from: z.string().min(3).max(254),
  token: z.string().min(8).max(255),
});

const ResendConfig = z.object({
  provider: z.literal('resend'),
  from: z.string().min(3).max(254),
  apiKey: z.string().min(8).max(255),
});

const SesConfig = z.object({
  provider: z.literal('ses'),
  from: z.string().min(3).max(254),
  region: z.string().min(2).max(64),
  accessKeyId: z.string().min(8).max(255),
  secretAccessKey: z.string().min(8).max(255),
});

const EmailItConfig = z.object({
  provider: z.literal('emailit'),
  from: z.string().min(3).max(254),
  apiKey: z.string().min(8).max(255),
});

export const EmailConfig = z.discriminatedUnion('provider', [
  SmtpConfig,
  PostmarkConfig,
  ResendConfig,
  SesConfig,
  EmailItConfig,
]);
export type EmailConfig = z.infer<typeof EmailConfig>;

// ----- SMS -----

export const SmsProviderId = z.enum(['textlink', 'twilio', 'sns']);
export type SmsProviderId = z.infer<typeof SmsProviderId>;

const TextLinkConfig = z.object({
  provider: z.literal('textlink'),
  apiKey: z.string().min(8).max(255),
});

const TwilioConfig = z.object({
  provider: z.literal('twilio'),
  from: z.string().min(3).max(32),
  accountSid: z.string().min(8).max(255),
  authToken: z.string().min(8).max(255),
});

const SnsConfig = z.object({
  provider: z.literal('sns'),
  region: z.string().min(2).max(64),
  accessKeyId: z.string().min(8).max(255),
  secretAccessKey: z.string().min(8).max(255),
});

export const SmsConfig = z.discriminatedUnion('provider', [
  TextLinkConfig,
  TwilioConfig,
  SnsConfig,
]);
export type SmsConfig = z.infer<typeof SmsConfig>;

// ----- Voice (0206) -----
//
// A SEPARATE Twilio account for automated voice calls (appointment
// reminders + staged status notifications), configured under Admin →
// Messaging → Voice. Carries the call settings alongside the creds:
// default Say voice + language, and the firm-local calling window.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Curated Twilio <Say> voices (Amazon Polly + legacy). The UI offers this
// list; the schema accepts any string so new Twilio voices work without a
// deploy.
export const SUGGESTED_VOICES = [
  'Polly.Joanna',
  'Polly.Matthew',
  'Polly.Salli',
  'Polly.Joey',
  'Polly.Kimberly',
  'Polly.Kendra',
  'Polly.Ivy',
  'alice',
  'man',
  'woman',
] as const;

export const VoiceConfig = z.object({
  provider: z.literal('twilio'),
  from: z.string().min(3).max(32),
  accountSid: z.string().min(8).max(255),
  authToken: z.string().min(8).max(255),
  defaultVoice: z.string().min(1).max(64).default('Polly.Joanna'),
  language: z.string().min(2).max(16).default('en-US'),
  // Firm-local calling window (HH:MM, 24h). Calls due outside it wait for
  // the window to open; the SMS fallback is not window-restricted.
  windowStart: z.string().regex(TIME_RE).default('09:00'),
  windowEnd: z.string().regex(TIME_RE).default('20:00'),
});
export type VoiceConfig = z.infer<typeof VoiceConfig>;

// ----- Encryption helpers (singleton key cached per process) -----

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const cfg = loadConfig();
  if (!cfg.KMS_KEY) {
    throw new Error('KMS_KEY not configured');
  }
  cachedKey = core.resolveKey(cfg.KMS_KEY);
  return cachedKey;
}

export function resetKeyCacheForTests(): void {
  cachedKey = null;
}

export function encryptEmailConfig(cfg: EmailConfig): string {
  return core.encryptJson(cfg, getKey());
}

export function decryptEmailConfig(envelope: string): EmailConfig {
  const raw = core.decryptJson(envelope, getKey());
  return EmailConfig.parse(raw);
}

export function encryptSmsConfig(cfg: SmsConfig): string {
  return core.encryptJson(cfg, getKey());
}

export function decryptSmsConfig(envelope: string): SmsConfig {
  const raw = core.decryptJson(envelope, getKey());
  return SmsConfig.parse(raw);
}

export function encryptVoiceConfig(cfg: VoiceConfig): string {
  return core.encryptJson(cfg, getKey());
}

export function decryptVoiceConfig(envelope: string): VoiceConfig {
  const raw = core.decryptJson(envelope, getKey());
  return VoiceConfig.parse(raw);
}

// ----- Masking for read responses -----
//
// API never returns plaintext secrets. The UI sees the provider id, the
// from-address / region / etc, and a "configured: true" flag for each
// secret-bearing field. Editing requires re-submitting the secret.

function mask(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}…${value.slice(-2)}`;
}

export interface MaskedEmailConfig {
  provider: EmailProviderId;
  from: string;
  host?: string;
  port?: number;
  secure?: boolean;
  userMasked?: string | null;
  passMasked?: string | null;
  tokenMasked?: string | null;
  apiKeyMasked?: string | null;
  region?: string;
  accessKeyIdMasked?: string | null;
  secretAccessKeyMasked?: string | null;
}

export function maskEmailConfig(cfg: EmailConfig): MaskedEmailConfig {
  switch (cfg.provider) {
    case 'smtp':
      return {
        provider: 'smtp',
        from: cfg.from,
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        userMasked: mask(cfg.user),
        passMasked: mask(cfg.pass),
      };
    case 'postmark':
      return { provider: 'postmark', from: cfg.from, tokenMasked: mask(cfg.token) };
    case 'resend':
      return { provider: 'resend', from: cfg.from, apiKeyMasked: mask(cfg.apiKey) };
    case 'emailit':
      return { provider: 'emailit', from: cfg.from, apiKeyMasked: mask(cfg.apiKey) };
    case 'ses':
      return {
        provider: 'ses',
        from: cfg.from,
        region: cfg.region,
        accessKeyIdMasked: mask(cfg.accessKeyId),
        secretAccessKeyMasked: mask(cfg.secretAccessKey),
      };
  }
}

export interface MaskedSmsConfig {
  provider: SmsProviderId;
  from?: string;
  region?: string;
  apiKeyMasked?: string | null;
  accountSidMasked?: string | null;
  authTokenMasked?: string | null;
  accessKeyIdMasked?: string | null;
  secretAccessKeyMasked?: string | null;
}

export interface MaskedVoiceConfig {
  provider: 'twilio';
  from: string;
  accountSidMasked: string | null;
  authTokenMasked: string | null;
  defaultVoice: string;
  language: string;
  windowStart: string;
  windowEnd: string;
}

export function maskVoiceConfig(cfg: VoiceConfig): MaskedVoiceConfig {
  return {
    provider: 'twilio',
    from: cfg.from,
    accountSidMasked: mask(cfg.accountSid),
    authTokenMasked: mask(cfg.authToken),
    defaultVoice: cfg.defaultVoice,
    language: cfg.language,
    windowStart: cfg.windowStart,
    windowEnd: cfg.windowEnd,
  };
}

export function maskSmsConfig(cfg: SmsConfig): MaskedSmsConfig {
  switch (cfg.provider) {
    case 'textlink':
      return { provider: 'textlink', apiKeyMasked: mask(cfg.apiKey) };
    case 'twilio':
      return {
        provider: 'twilio',
        from: cfg.from,
        accountSidMasked: mask(cfg.accountSid),
        authTokenMasked: mask(cfg.authToken),
      };
    case 'sns':
      return {
        provider: 'sns',
        region: cfg.region,
        accessKeyIdMasked: mask(cfg.accessKeyId),
        secretAccessKeyMasked: mask(cfg.secretAccessKey),
      };
  }
}
