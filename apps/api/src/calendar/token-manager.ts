// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-2/CAL-3 — keep a connection's access token fresh. If it expires
// within 5 minutes, refresh it and persist the rotated tokens (re-wrapped
// under a new per-record DEK). Returns a usable access token.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { staffCalendarConnections } from '@vibe/db/schema';

import { encField, newCalendarRecordKey } from './crypto';
import { refreshTokens, type CalendarProvider } from './oauth';
import { decryptConnectionTokens, type ProviderCreds } from './store';

const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface ConnectionRow {
  id: string;
  firmId: string;
  provider: string;
  tDekWrapped: Buffer;
  accessTokenEnc: Buffer;
  refreshTokenEnc: Buffer | null;
  tokenExpiry: Date | null;
}

/**
 * Return a non-expired access token for the connection, refreshing +
 * persisting if it's within the refresh window. Throws if a refresh is
 * needed but no refresh token is stored (caller should surface re-auth).
 */
export async function ensureFreshAccessToken(
  db: Database,
  connection: ConnectionRow,
  creds: ProviderCreds,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<string> {
  const tokens = decryptConnectionTokens(db, connection.firmId, connection);
  const expiry = connection.tokenExpiry;
  const expiringSoon = !expiry || expiry.getTime() - now.getTime() < REFRESH_WINDOW_MS;
  if (!expiringSoon) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error('token_expired');

  const set = await refreshTokens(
    connection.provider as CalendarProvider,
    {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      tenantId: creds.tenantId,
      refreshToken: tokens.refreshToken,
    },
    fetchImpl,
    now,
  );

  const { dek, wrappedDek } = newCalendarRecordKey(db, connection.firmId);
  await db
    .update(staffCalendarConnections)
    .set({
      tDekWrapped: Buffer.from(wrappedDek),
      accessTokenEnc: encField(dek, set.accessToken)!,
      refreshTokenEnc: encField(dek, set.refreshToken),
      tokenExpiry: set.expiresAt,
      scope: set.scope ?? undefined,
      syncError: null,
      updatedAt: now,
    })
    .where(eq(staffCalendarConnections.id, connection.id));

  return set.accessToken;
}
