// SPDX-License-Identifier: Elastic-2.0
//
// 0121 — worker-safe loader for a firm's DB-backed SMS provider (configured
// in Admin → Messaging, encrypted at rest under KMS_KEY). Deliberately avoids
// importing ./config (which pulls zod + the app config schema) so the worker
// bundle stays lean: it decrypts with @vibe/core directly and builds the
// provider from the zod-free ../sms/provider helpers. Returns null when the
// firm has no DB config (caller falls back to env), KMS_KEY is unset, or the
// provider isn't usable.

import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';

import { crypto as core } from '@vibe/core';
import type { Database } from '@vibe/db';
import { firmSettings } from '@vibe/db/schema';

import {
  createTextLinkSmsProvider,
  createTwilioSmsProvider,
  type SmsProvider,
} from '../sms/provider';

interface StoredSmsConfig {
  provider: 'textlink' | 'twilio' | 'sns';
  apiKey?: string;
  from?: string;
  accountSid?: string;
  authToken?: string;
}

export async function loadFirmSmsProvider(
  db: Database,
  firmId: string,
  log: Logger,
): Promise<SmsProvider | null> {
  const [row] = await db
    .select({ enc: firmSettings.smsConfigEncrypted })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  if (!row?.enc) return null; // no DB config → caller uses env fallback
  const keyRaw = process.env['KMS_KEY'];
  if (!keyRaw) {
    log.warn({ firmId }, 'sms config present but KMS_KEY unset; cannot decrypt');
    return null;
  }
  let cfg: StoredSmsConfig;
  try {
    cfg = core.decryptJson<StoredSmsConfig>(row.enc, core.resolveKey(keyRaw));
  } catch (err) {
    log.warn({ err, firmId }, 'sms config decrypt failed');
    return null;
  }
  try {
    if (cfg.provider === 'twilio' && cfg.accountSid && cfg.authToken && cfg.from) {
      return createTwilioSmsProvider(
        { accountSid: cfg.accountSid, authToken: cfg.authToken, from: cfg.from },
        log,
      );
    }
    if (cfg.provider === 'textlink' && cfg.apiKey) {
      return createTextLinkSmsProvider({ apiKey: cfg.apiKey }, log);
    }
    log.warn({ firmId, provider: cfg.provider }, 'sms provider not usable for reminders');
    return null;
  } catch (err) {
    log.warn({ err, firmId }, 'sms provider build failed');
    return null;
  }
}
