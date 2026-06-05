// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-2 — PUBLIC OAuth callback (mounted at /api/calendar, outside the
// staff auth chain). It MUST be public: the provider redirects the browser
// cross-site, and the SameSite=Strict staff session cookie isn't sent. The
// staff identity comes entirely from the one-time `state` we stored in
// Redis at connect time. On success we store the (encrypted) tokens, fetch
// the calendar list, and bounce back to the staff Account page.

import express, { type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { staffCalendarConnections } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { logger } from '../logger';
import { encField, newCalendarRecordKey } from './crypto';
import { exchangeCode, fetchIdentity, listCalendars, type CalendarProvider } from './oauth';
import {
  callbackRedirectUri,
  stateKey,
  upsertCalendarList,
  type OAuthStatePayload,
  type OAuthStateStore,
} from './connect-shared';
import { getProviderCreds } from './store';

export interface CalendarPublicDeps {
  db: Database | null;
  stateStore: OAuthStateStore;
  redirectBase: string;
  /** Where to send the browser after the callback (the staff Account page). */
  appBaseUrl: string;
  fetchImpl?: typeof fetch;
}

const PROVIDERS = ['microsoft', 'google'] as const;
function isProvider(v: string): v is CalendarProvider {
  return (PROVIDERS as readonly string[]).includes(v);
}

export function createCalendarPublicRouter(deps: CalendarPublicDeps): Router {
  const router = express.Router();
  const doFetch = deps.fetchImpl ?? fetch;
  const accountUrl = (status: 'success' | 'error'): string =>
    `${deps.appBaseUrl.replace(/\/$/, '')}/account?cal_connect=${status}`;

  router.get('/oauth/callback/:provider', async (req: Request, res: Response) => {
    const provider = req.params['provider']!;
    const state = String(req.query['state'] ?? '');
    const code = String(req.query['code'] ?? '');
    if (!isProvider(provider) || !state) {
      res.status(400).send('invalid_request');
      return;
    }
    if (!deps.db) {
      res.status(503).send('db_unavailable');
      return;
    }

    // Validate + consume the one-time state.
    const raw = await deps.stateStore.get(stateKey(state));
    if (!raw) {
      res.status(400).send('invalid_or_expired_state');
      return;
    }
    await deps.stateStore.del(stateKey(state));
    let payload: OAuthStatePayload;
    try {
      payload = JSON.parse(raw) as OAuthStatePayload;
    } catch {
      res.status(400).send('invalid_state');
      return;
    }
    if (payload.provider !== provider) {
      res.status(400).send('provider_mismatch');
      return;
    }

    // The provider may report a user-cancel as ?error=...
    if (req.query['error']) {
      logger.warn({ provider, error: req.query['error'] }, 'calendar oauth declined');
      res.redirect(accountUrl('error'));
      return;
    }

    try {
      const creds = await getProviderCreds(deps.db, payload.firmId, provider);
      if (!creds) throw new Error('provider_not_configured');

      const tokens = await exchangeCode(
        provider,
        {
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          tenantId: creds.tenantId,
          redirectUri: callbackRedirectUri(deps.redirectBase, provider),
          code,
        },
        doFetch,
      );
      const identity = await fetchIdentity(provider, tokens.accessToken, doFetch);

      // Upsert the connection (one per staff per provider).
      const { dek, wrappedDek } = newCalendarRecordKey(deps.db, payload.firmId);
      const [conn] = await deps.db
        .insert(staffCalendarConnections)
        .values({
          firmId: payload.firmId,
          staffId: payload.staffId,
          provider,
          tDekWrapped: Buffer.from(wrappedDek),
          accessTokenEnc: encField(dek, tokens.accessToken)!,
          refreshTokenEnc: encField(dek, tokens.refreshToken),
          tokenExpiry: tokens.expiresAt,
          scope: tokens.scope,
          providerUserId: identity.providerUserId,
          providerEmail: identity.providerEmail,
          enabled: true,
          syncError: null,
          consecutiveFailures: 0,
        })
        .onConflictDoUpdate({
          target: [staffCalendarConnections.staffId, staffCalendarConnections.provider],
          set: {
            tDekWrapped: Buffer.from(wrappedDek),
            accessTokenEnc: encField(dek, tokens.accessToken)!,
            refreshTokenEnc: encField(dek, tokens.refreshToken),
            tokenExpiry: tokens.expiresAt,
            scope: tokens.scope,
            providerUserId: identity.providerUserId,
            providerEmail: identity.providerEmail,
            enabled: true,
            syncError: null,
            consecutiveFailures: 0,
            updatedAt: new Date(),
          },
        })
        .returning({ id: staffCalendarConnections.id });

      // Fetch + store the calendar list (primary pre-enabled).
      try {
        const calendars = await listCalendars(provider, tokens.accessToken, doFetch);
        await upsertCalendarList(deps.db, conn!.id, calendars);
      } catch (err) {
        logger.warn({ err, connectionId: conn!.id }, 'initial calendar list fetch failed');
      }

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'staff_calendar_connection',
        entityId: conn!.id,
        actorAppUserId: payload.staffId,
        after: { provider, providerEmail: identity.providerEmail },
      });
      res.redirect(accountUrl('success'));
    } catch (err) {
      logger.error({ err, provider }, 'calendar oauth callback failed');
      // Record the failure on any existing connection for visibility.
      await deps.db
        .update(staffCalendarConnections)
        .set({ syncError: 'auth_failed', updatedAt: new Date() })
        .where(eq(staffCalendarConnections.staffId, payload.staffId))
        .catch(() => undefined);
      res.redirect(accountUrl('error'));
    }
  });

  return router;
}
