// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Vibe Print LAN gateway config. PGW-1 (0228): gateways are rows in
// print_gateway — one per office LAN for multi-location firms — each
// with its own encrypted bearer key. Resolution precedence: explicit
// gatewayId → office's gateway → firm default row → the legacy
// firm_settings blob (implicit default while the table is empty,
// D-PGW-02) → env pair PRINT_GATEWAY_BASE_URL / PRINT_GATEWAY_API_KEY
// (single-gateway-only, D-PGW-07). All secrets encrypted under KMS_KEY
// (same envelope as Stripe/mail/sms config).

import { asc, eq } from 'drizzle-orm';

import { crypto as core } from '@vibe/core';
import type { Database } from '@vibe/db';
import { firmSettings, offices, printGateways } from '@vibe/db/schema';

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
  /** print_gateway row id, or the implicit 'legacy' blob / 'env' pair. */
  id: string | 'legacy' | 'env';
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  defaultPrinterId: number | null;
  autoPrintSignatureConfirmation: boolean;
  /** Office this gateway serves; null = firm-wide. */
  officeId: string | null;
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

// ── PGW-1: per-row gateway key envelope ───────────────────────────────

/** Encrypt a gateway bearer key for print_gateway.api_key_encrypted. */
export function encryptGatewayApiKey(apiKey: string): string {
  return core.encryptJson({ apiKey }, kmsKey());
}

function decryptGatewayApiKey(enc: string): string | null {
  if (!process.env['KMS_KEY']) return null;
  try {
    return core.decryptJson<{ apiKey: string }>(enc, kmsKey()).apiKey ?? null;
  } catch {
    return null;
  }
}

type GatewayRow = typeof printGateways.$inferSelect;

function toResolved(row: GatewayRow): ResolvedPrintGateway | null {
  const apiKey = decryptGatewayApiKey(row.apiKeyEncrypted);
  if (!row.baseUrl || !apiKey) return null;
  return {
    id: row.id,
    baseUrl: normalizeBase(row.baseUrl),
    apiKey,
    enabled: row.enabled,
    defaultPrinterId: row.defaultPrinterId ?? null,
    autoPrintSignatureConfirmation: row.autoPrintSignatureConfirmation,
    officeId: row.officeId ?? null,
  };
}

/** Admin/picker listing — keys masked, never returned in the clear. */
export interface GatewayListEntry {
  id: string;
  name: string;
  officeId: string | null;
  officeName: string | null;
  baseUrl: string;
  apiKeyMasked: string | null;
  enabled: boolean;
  isDefault: boolean;
  defaultPrinterId: number | null;
  autoPrintSignatureConfirmation: boolean;
}

export async function listGateways(db: Database, firmId: string): Promise<GatewayListEntry[]> {
  const rows = await db
    .select({ gw: printGateways, officeName: offices.name })
    .from(printGateways)
    .leftJoin(offices, eq(offices.id, printGateways.officeId))
    .where(eq(printGateways.firmId, firmId))
    .orderBy(asc(printGateways.createdAt));
  return rows.map(({ gw, officeName }) => ({
    id: gw.id,
    name: gw.name,
    officeId: gw.officeId ?? null,
    officeName: officeName ?? null,
    baseUrl: gw.baseUrl,
    apiKeyMasked: mask(decryptGatewayApiKey(gw.apiKeyEncrypted) ?? undefined),
    enabled: gw.enabled,
    isDefault: gw.isDefault,
    defaultPrinterId: gw.defaultPrinterId ?? null,
    autoPrintSignatureConfirmation: gw.autoPrintSignatureConfirmation,
  }));
}

/**
 * Resolve the effective gateway target. Precedence (D-PGW-02/05/07):
 *
 *   1. `opts.gatewayId` — that exact print_gateway row; if the row is
 *      gone, resolution FAILS (null) rather than falling back to another
 *      site's gateway (D-PGW-06).
 *   2. `opts.officeId` — the office's gateway (enabled preferred,
 *      created_at ties), else the firm-default row.
 *   3. The firm-default print_gateway row (or, if none is flagged, the
 *      oldest row — deterministic).
 *   4. While the print_gateway table is empty for the firm: the legacy
 *      firm_settings blob as the implicit default (id 'legacy').
 *   5. Env pair PRINT_GATEWAY_BASE_URL/_API_KEY (id 'env').
 *
 * Returns null when nothing usable exists. `enabled:false` is still
 * returned so callers can distinguish "configured but off".
 */
export async function resolvePrintGateway(
  db: Database,
  firmId: string,
  opts: { gatewayId?: string | null; officeId?: string | null } = {},
): Promise<ResolvedPrintGateway | null> {
  const rows = await db
    .select()
    .from(printGateways)
    .where(eq(printGateways.firmId, firmId))
    .orderBy(asc(printGateways.createdAt));

  if (opts.gatewayId) {
    const row = rows.find((r) => r.id === opts.gatewayId);
    return row ? toResolved(row) : null;
  }

  if (rows.length > 0) {
    let row: GatewayRow | undefined;
    if (opts.officeId) {
      const forOffice = rows.filter((r) => r.officeId === opts.officeId);
      row = forOffice.find((r) => r.enabled) ?? forOffice[0];
    }
    row ??= rows.find((r) => r.isDefault) ?? rows.find((r) => r.enabled) ?? rows[0];
    return row ? toResolved(row) : null;
  }

  // Legacy blob → env (pre-0228 behavior, unchanged).
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
    id: dbHasConnection ? 'legacy' : 'env',
    baseUrl: normalizeBase(baseUrl),
    apiKey,
    enabled: dbHasConnection ? Boolean(cfg?.enabled) : true,
    defaultPrinterId: cfg?.defaultPrinterId ?? null,
    autoPrintSignatureConfirmation: Boolean(cfg?.autoPrintSignatureConfirmation),
    officeId: null,
  };
}
