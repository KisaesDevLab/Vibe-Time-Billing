// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-2/CAL-3 — keep a connection's access token fresh. If it expires
// within 5 minutes, refresh it and persist the rotated tokens (re-wrapped
// under a new per-record DEK). Returns a usable access token.

import { and, eq, isNull } from 'drizzle-orm';

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

  // Compare-and-set on the expiry we read: if another caller (api vs
  // worker) refreshed concurrently and already persisted, discard OUR
  // token set and use theirs — persisting both would overwrite the
  // winner's rotated refresh token (Microsoft rotates RTs) and corrupt
  // the connection.
  const expiryUnchanged = expiry
    ? eq(staffCalendarConnections.tokenExpiry, expiry)
    : isNull(staffCalendarConnections.tokenExpiry);
  const { dek, wrappedDek } = newCalendarRecordKey(db, connection.firmId);
  const updated = await db
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
    .where(and(eq(staffCalendarConnections.id, connection.id), expiryUnchanged))
    .returning({ id: staffCalendarConnections.id });
  if (updated.length > 0) return set.accessToken;

  // Lost the race — return the winner's stored token.
  const [fresh] = await db
    .select()
    .from(staffCalendarConnections)
    .where(eq(staffCalendarConnections.id, connection.id))
    .limit(1);
  if (!fresh) throw new Error('token_expired');
  return decryptConnectionTokens(db, connection.firmId, fresh).accessToken;
}
