// SPDX-License-Identifier: Elastic-2.0
//
// Firm-configurable inbound webhook signing secrets for the notification
// providers. Stored encrypted under KMS_KEY (same envelope as mail/sms/stripe
// config). Each receiver resolves its secret DB-first, env-fallback. Cached
// briefly (single-firm appliance) so high-volume callbacks don't decrypt per
// request; an admin change takes effect within the TTL.

import { eq } from 'drizzle-orm';

import { crypto as core } from '@vibe/core';
import type { Database } from '@vibe/db';
import { firmSettings, firms } from '@vibe/db/schema';

export const WEBHOOK_PROVIDERS = ['postmark', 'resend', 'twilio', 'textlink'] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];
export type WebhookKeys = Partial<Record<WebhookProvider, string>>;

function kmsKey(): Buffer {
  const raw = process.env['KMS_KEY'];
  if (!raw) throw new Error('KMS_KEY unset');
  return core.resolveKey(raw);
}

export async function loadFirmWebhookKeys(
  db: Database,
  firmId: string,
): Promise<WebhookKeys | null> {
  const [row] = await db
    .select({ enc: firmSettings.webhookKeysEncrypted })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  if (!row?.enc || !process.env['KMS_KEY']) return null;
  try {
    return core.decryptJson<WebhookKeys>(row.enc, kmsKey());
  } catch {
    return null;
  }
}

export function encryptWebhookKeys(keys: WebhookKeys): string {
  return core.encryptJson(keys, kmsKey());
}

export function maskWebhookKeys(keys: WebhookKeys | null): Record<WebhookProvider, boolean> {
  const out = {} as Record<WebhookProvider, boolean>;
  for (const p of WEBHOOK_PROVIDERS) out[p] = Boolean(keys?.[p]);
  return out;
}

let cache: { keys: WebhookKeys | null; at: number } | null = null;
const TTL_MS = 60_000;

export async function resolveWebhookSecret(
  db: Database | null,
  provider: WebhookProvider,
  envFallback: string | null | undefined,
  now: () => number = Date.now,
): Promise<string | null> {
  const fallback = envFallback ?? null;
  if (!db) return fallback;
  const t = now();
  if (!cache || t - cache.at >= TTL_MS) {
    let keys: WebhookKeys | null = null;
    try {
      const [firm] = await db.select({ id: firms.id }).from(firms).limit(1);
      if (firm) keys = await loadFirmWebhookKeys(db, firm.id);
    } catch {
      keys = null;
    }
    cache = { keys, at: t };
  }
  return cache.keys?.[provider] ?? fallback;
}

/** Test-only: reset the module cache so resolver tests are deterministic. */
export function __resetWebhookKeyCache(): void {
  cache = null;
}
