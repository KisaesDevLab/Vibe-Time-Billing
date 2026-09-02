// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0233 — the origin Twilio reaches the appliance on. Signature validation
// and StatusCallback URLs must use the PUBLIC origin (what the firm pasted
// into the Twilio console), never the internal request host. Precedence:
// firm_settings.sms_public_base_url → PUBLIC_BASE_URL → APP_BASE_URL.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettings } from '@vibe/db/schema';

export interface SmsPublicUrlConfig {
  PUBLIC_BASE_URL?: string | undefined;
  APP_BASE_URL: string;
}

export interface ResolvedSmsPublicUrl {
  baseUrl: string;
  source: 'firm' | 'public_base_url' | 'app_base_url';
  /** every configured base, most specific first — for signature candidates */
  candidates: string[];
}

function clean(u: string | null | undefined): string | null {
  const s = (u ?? '').trim().replace(/\/+$/, '');
  return s || null;
}

export function resolveSmsPublicBaseUrlFrom(
  firmOverride: string | null | undefined,
  config: SmsPublicUrlConfig,
): ResolvedSmsPublicUrl {
  const firm = clean(firmOverride);
  const pub = clean(config.PUBLIC_BASE_URL);
  const app = clean(config.APP_BASE_URL) ?? 'http://localhost:3001';
  const candidates = [...new Set([firm, pub, app].filter((x): x is string => Boolean(x)))];
  if (firm) return { baseUrl: firm, source: 'firm', candidates };
  if (pub) return { baseUrl: pub, source: 'public_base_url', candidates };
  return { baseUrl: app, source: 'app_base_url', candidates };
}

export async function resolveSmsPublicBaseUrl(
  db: Database | null,
  firmId: string | null,
  config: SmsPublicUrlConfig,
): Promise<ResolvedSmsPublicUrl> {
  let firmOverride: string | null = null;
  if (db && firmId) {
    const [row] = await db
      .select({ v: firmSettings.smsPublicBaseUrl })
      .from(firmSettings)
      .where(eq(firmSettings.firmId, firmId))
      .limit(1);
    firmOverride = row?.v ?? null;
  }
  return resolveSmsPublicBaseUrlFrom(firmOverride, config);
}

export const SMS_INBOUND_WEBHOOK_PATH = '/api/sms/twilio/inbound';
export const SMS_STATUS_WEBHOOK_PATH = '/api/sms/twilio/status';

export function smsWebhookUrls(baseUrl: string): { inbound: string; status: string } {
  const b = baseUrl.replace(/\/+$/, '');
  return { inbound: b + SMS_INBOUND_WEBHOOK_PATH, status: b + SMS_STATUS_WEBHOOK_PATH };
}
