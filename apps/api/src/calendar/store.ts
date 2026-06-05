// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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

/** Decrypted firm OAuth app credentials for a provider (null if absent). */
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
  if (!row) return null;
  const dek = unwrapCalendarRecordKey(db, firmId, row.tDekWrapped);
  return {
    clientId: decField(dek, row.clientIdEnc) ?? '',
    clientSecret: decField(dek, row.clientSecretEnc) ?? '',
    tenantId: decField(dek, row.tenantIdEnc),
    enabled: row.enabled,
  };
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
