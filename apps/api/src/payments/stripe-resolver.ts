// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Firm-owned Stripe credentials (Q7), entered in Admin → Stripe and stored
// encrypted at rest under KMS_KEY — same envelope as mail/sms config. These
// helpers load/encrypt the config and produce a masked view for the UI.
//
// The live payment provider + webhook-secret are resolved from this stored
// config at api boot (apps/api/src/server.ts, via resolveFirmStripe), ahead
// of the appliance env vars. Single-firm appliance, so this is resolved once
// per process start — saving a new key here takes effect on the next api
// restart. The "Test" endpoint validates the keys against Stripe immediately
// regardless of when the boot-time value was resolved.

import { eq } from 'drizzle-orm';

import { crypto as core } from '@vibe/core';
import type { Database } from '@vibe/db';
import { firmSettings } from '@vibe/db/schema';

export interface StoredStripeConfig {
  secretKey?: string;
  publishableKey?: string;
  webhookSecret?: string;
}

export interface MaskedStripeConfig {
  secretKeyMasked: string | null;
  publishableKeyMasked: string | null;
  webhookSecretSet: boolean;
}

function kmsKey(): Buffer {
  const raw = process.env['KMS_KEY'];
  if (!raw) throw new Error('KMS_KEY unset');
  return core.resolveKey(raw);
}

export async function loadFirmStripeConfig(
  db: Database,
  firmId: string,
): Promise<StoredStripeConfig | null> {
  const [row] = await db
    .select({ enc: firmSettings.stripeConfigEncrypted })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  if (!row?.enc) return null;
  if (!process.env['KMS_KEY']) return null;
  try {
    return core.decryptJson<StoredStripeConfig>(row.enc, kmsKey());
  } catch {
    return null;
  }
}

export function encryptStripeConfig(cfg: StoredStripeConfig): string {
  return core.encryptJson(cfg, kmsKey());
}

/** Show only a key's last 4 chars; never echo a stored secret back. */
function mask(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

export function maskStripeConfig(cfg: StoredStripeConfig | null): MaskedStripeConfig {
  return {
    secretKeyMasked: mask(cfg?.secretKey),
    publishableKeyMasked: mask(cfg?.publishableKey),
    webhookSecretSet: Boolean(cfg?.webhookSecret),
  };
}

/** Live validation: hit the Stripe Balance endpoint with the secret key. */
export async function testStripeSecretKey(
  secretKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    return { ok: false, error: body.error?.message ?? `stripe ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'request_failed' };
  }
}
