// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-2 — decrypt helpers shared by the connect flow + sync engine. Reads
// the firm's provider config and a staff connection's tokens out of their
// MFK envelopes. Plaintext secrets/tokens live only in memory here.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { calendarProviderConfig, staffCalendarConnections } from '@vibe/db/schema';

import { decField, unwrapCalendarRecordKey } from './crypto';
import type { CalendarProvider } from './oauth';

export interface ProviderCreds {
  clientId: string;
  clientSecret: string;
  tenantId: string | null;
  enabled: boolean;
}

/**
 * Appliance-level OAuth app credentials from env (CAL-2). When present, every
 * staff member connects their OWN calendar by signing in — no per-firm app
 * registration and no org-wide admin consent. Returns null when the operator
 * hasn't configured an appliance app for this provider.
 *
 * Reads process.env directly (not the zod config) so this module stays free of
 * the config import — the worker imports this file transitively and must not
 * pull the full config schema (+ zod) into its bundle.
 */
export function applianceProviderCreds(provider: CalendarProvider): ProviderCreds | null {
  const env = process.env;
  if (provider === 'microsoft') {
    if (env['CALENDAR_MS_CLIENT_ID'] && env['CALENDAR_MS_CLIENT_SECRET']) {
      return {
        clientId: env['CALENDAR_MS_CLIENT_ID'],
        clientSecret: env['CALENDAR_MS_CLIENT_SECRET'],
        tenantId: env['CALENDAR_MS_TENANT_ID'] || 'common',
        enabled: true,
      };
    }
    return null;
  }
  if (env['CALENDAR_GOOGLE_CLIENT_ID'] && env['CALENDAR_GOOGLE_CLIENT_SECRET']) {
    return {
      clientId: env['CALENDAR_GOOGLE_CLIENT_ID'],
      clientSecret: env['CALENDAR_GOOGLE_CLIENT_SECRET'],
      tenantId: null,
      enabled: true,
    };
  }
  return null;
}

/** True when the appliance has an env-configured OAuth app for this provider
 *  (cheap check for the providers-availability list). */
export function applianceProviderAvailable(provider: CalendarProvider): boolean {
  return applianceProviderCreds(provider) !== null;
}

/**
 * Decrypted OAuth app credentials for a provider. Prefers the firm's own
 * pasted app; falls back to the appliance-level env app (CAL-2) so staff can
 * just sign in. Null when neither is configured.
 */
export async function getProviderCreds(
  db: Database,
  firmId: string,
  provider: CalendarProvider,
): Promise<ProviderCreds | null> {
  const [row] = await db
    .select()
    .from(calendarProviderConfig)
    .where(
      and(eq(calendarProviderConfig.firmId, firmId), eq(calendarProviderConfig.provider, provider)),
    )
    .limit(1);
  if (row) {
    const dek = unwrapCalendarRecordKey(db, firmId, row.tDekWrapped);
    const clientId = decField(dek, row.clientIdEnc) ?? '';
    const clientSecret = decField(dek, row.clientSecretEnc) ?? '';
    // A firm row with complete creds wins; an empty/partial row falls through
    // to the appliance app so staff aren't blocked.
    if (clientId && clientSecret) {
      return {
        clientId,
        clientSecret,
        tenantId: decField(dek, row.tenantIdEnc),
        enabled: row.enabled,
      };
    }
  }
  return applianceProviderCreds(provider);
}

export interface ConnectionTokens {
  accessToken: string;
  refreshToken: string | null;
}

/** Decrypt a connection's stored OAuth tokens. */
export function decryptConnectionTokens(
  db: Database,
  firmId: string,
  row: {
    tDekWrapped: Buffer;
    accessTokenEnc: Buffer;
    refreshTokenEnc: Buffer | null;
  },
): ConnectionTokens {
  const dek = unwrapCalendarRecordKey(db, firmId, row.tDekWrapped);
  return {
    accessToken: decField(dek, row.accessTokenEnc) ?? '',
    refreshToken: decField(dek, row.refreshTokenEnc),
  };
}

/** Load a connection row by id within a firm. */
export async function loadConnection(db: Database, firmId: string, id: string) {
  const [row] = await db
    .select()
    .from(staffCalendarConnections)
    .where(and(eq(staffCalendarConnections.id, id), eq(staffCalendarConnections.firmId, firmId)))
    .limit(1);
  return row ?? null;
}
