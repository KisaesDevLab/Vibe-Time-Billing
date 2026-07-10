// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Vibe Print LAN gateway config — firm-owned base URL + bearer key (and
// default printer / auto-print toggle), stored encrypted at rest under
// KMS_KEY (same envelope as Stripe/mail/sms config). Env vars
// PRINT_GATEWAY_BASE_URL / PRINT_GATEWAY_API_KEY are a fallback.

import { eq } from 'drizzle-orm';

import { crypto as core } from '@vibe/core';
import type { Database } from '@vibe/db';
import { firmSettings } from '@vibe/db/schema';

export interface StoredPrintGatewayConfig {
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  /** Firm default printer (gateway numeric id) used for automated prints. */
  defaultPrinterId?: number;
  /** Auto-print a confirmation report when a tax return is signed. */
  autoPrintSignatureConfirmation?: boolean;
}

export interface MaskedPrintGatewayConfig {
  baseUrl: string | null;
  apiKeyMasked: string | null;
  enabled: boolean;
  defaultPrinterId: number | null;
  autoPrintSignatureConfirmation: boolean;
}

/** A usable gateway target (URL + key + flags), DB config over env fallback. */
export interface ResolvedPrintGateway {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  defaultPrinterId: number | null;
  autoPrintSignatureConfirmation: boolean;
}

function kmsKey(): Buffer {
  const raw = process.env['KMS_KEY'];
  if (!raw) throw new Error('KMS_KEY unset');
  return core.resolveKey(raw);
}

export function encryptPrintGatewayConfig(cfg: StoredPrintGatewayConfig): string {
  return core.encryptJson(cfg, kmsKey());
}

export async function loadPrintGatewayConfig(
  db: Database,
  firmId: string,
): Promise<StoredPrintGatewayConfig | null> {
  const [row] = await db
    .select({ enc: firmSettings.printGatewayConfigEncrypted })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  if (!row?.enc) return null;
  if (!process.env['KMS_KEY']) return null;
  try {
    return core.decryptJson<StoredPrintGatewayConfig>(row.enc, kmsKey());
  } catch {
    return null;
  }
}

function mask(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

export function maskPrintGatewayConfig(
  cfg: StoredPrintGatewayConfig | null,
): MaskedPrintGatewayConfig {
  return {
    baseUrl: cfg?.baseUrl ?? null,
    apiKeyMasked: mask(cfg?.apiKey),
    enabled: Boolean(cfg?.enabled),
    defaultPrinterId: cfg?.defaultPrinterId ?? null,
    autoPrintSignatureConfirmation: Boolean(cfg?.autoPrintSignatureConfirmation),
  };
}

function normalizeBase(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * Resolve the effective gateway target: firm DB config wins, else env.
 * Returns null when there is no base URL + key to use. `enabled:false` is
 * still returned so callers can distinguish "configured but off".
 */
export async function resolvePrintGateway(
  db: Database,
  firmId: string,
): Promise<ResolvedPrintGateway | null> {
  const cfg = await loadPrintGatewayConfig(db, firmId);
  const baseUrl = cfg?.baseUrl || process.env['PRINT_GATEWAY_BASE_URL'] || '';
  const apiKey = cfg?.apiKey || process.env['PRINT_GATEWAY_API_KEY'] || '';
  if (!baseUrl || !apiKey) return null;
  // The `enabled` toggle only governs a gateway the firm configured via the
  // DB (admin UI). When the connection comes from env (the DB row carries no
  // baseUrl+apiKey — e.g. the firm only saved a default printer), the toggle
  // is irrelevant and the env-backed gateway is treated as enabled.
  const dbHasConnection = Boolean(cfg?.baseUrl && cfg?.apiKey);
  return {
    baseUrl: normalizeBase(baseUrl),
    apiKey,
    enabled: dbHasConnection ? Boolean(cfg?.enabled) : true,
    defaultPrinterId: cfg?.defaultPrinterId ?? null,
    autoPrintSignatureConfirmation: Boolean(cfg?.autoPrintSignatureConfirmation),
  };
}
