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

import { firms } from '@vibe/db/schema';

import {
  createTextLinkSmsProvider,
  createTwilioSmsProvider,
  type SmsMessage,
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

const FIRM_SMS_TTL_MS = 60_000;

/**
 * Wrap a base (env-configured) SMS provider so every send first tries the
 * firm's DB-saved provider (Admin → Messaging) — the same config the
 * "test SMS" button and the worker use — and falls back to the base
 * provider only when no usable DB config exists. Single-firm appliance:
 * resolves the lone firm (mirrors loadEmailBranding). Resolution is cached
 * briefly so high-volume sends don't decrypt per message; an admin config
 * change takes effect within the TTL.
 */
export function wrapSmsWithFirmConfig(
  base: SmsProvider,
  deps: { db: Database | null; log: Logger },
): SmsProvider {
  let cached: SmsProvider | null = null;
  let cachedAt = 0;
  async function resolve(): Promise<SmsProvider> {
    if (!deps.db) return base;
    const now = Date.now();
    if (now - cachedAt < FIRM_SMS_TTL_MS) return cached ?? base;
    try {
      const [firm] = await deps.db.select({ id: firms.id }).from(firms).limit(1);
      cached = firm ? await loadFirmSmsProvider(deps.db, firm.id, deps.log) : null;
    } catch (err) {
      deps.log.warn({ err }, 'firm sms provider resolve failed; using env fallback');
      cached = null;
    }
    cachedAt = now;
    return cached ?? base;
  }
  return {
    id: base.id,
    async send(msg: SmsMessage) {
      return (await resolve()).send(msg);
    },
  };
}
