// SPDX-License-Identifier: Elastic-2.0
//
// CAL-2 — PUBLIC OAuth callback (mounted at /api/calendar, outside the
// staff auth chain). It MUST be public: the provider redirects the browser
// cross-site, and the SameSite=Strict staff session cookie isn't sent. The
// staff identity comes entirely from the one-time `state` we stored in
// Redis at connect time. On success we store the (encrypted) tokens, fetch
// the calendar list, and bounce back to the staff Account page.

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { checkAndIncrement } from '@vibe/core/auth';
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
  SYNC_ERROR_CALENDAR_LIST_FAILED,
  type OAuthStatePayload,
  type OAuthStateStore,
} from './connect-shared';
import { getProviderCreds, loadConnection } from './store';
import { getCalendarSettings } from './settings';
import { syncConnection } from './sync';

export interface CalendarPublicDeps {
  db: Database | null;
  redis?: Redis | null;
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

const IP_WINDOW_SECONDS = 60;
const IP_MAX_PER_WINDOW = 30;

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.ip ?? '0.0.0.0').trim();
}

export function createCalendarPublicRouter(deps: CalendarPublicDeps): Router {
  const router = express.Router();
  const doFetch = deps.fetchImpl ?? fetch;

  // Per-IP rate limit on the public callback. The one-time `state` already
  // bounds replay; this caps brute-force attempts against state/code params.
  const redis = deps.redis;
  if (redis) {
    router.use((req: Request, res: Response, next: NextFunction) => {
      void checkAndIncrement(redis, {
        key: `rl:caloauth:ip:${clientIp(req)}`,
        windowSeconds: IP_WINDOW_SECONDS,
        max: IP_MAX_PER_WINDOW,
      })
        .then((limit) => {
          if (!limit.allowed) {
            res.setHeader('Retry-After', String(limit.retryAfterSeconds));
            res.status(429).send('rate_limited');
            return;
          }
          next();
        })
        .catch((err: unknown) => {
          logger.warn({ err }, 'calendar oauth rate limiter error; allowing');
          next();
        });
    });
  }
  const accountUrl = (status: 'success' | 'error', reason?: string): string =>
    `${deps.appBaseUrl.replace(/\/$/, '')}/account?cal_connect=${status}` +
    (reason ? `&cal_error=${reason}` : '');

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
      res.redirect(accountUrl('error', 'declined'));
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

      // Fetch + store the calendar list (primary pre-enabled). A failure
      // here must not fail the connect (tokens are stored and "Refresh
      // calendars" can recover), but mark the connection so the UI shows
      // it rather than a healthy-looking connection with no calendars.
      let calendarListOk = true;
      try {
        const calendars = await listCalendars(provider, tokens.accessToken, doFetch);
        await upsertCalendarList(deps.db, conn!.id, calendars);
      } catch (err) {
        calendarListOk = false;
        logger.warn({ err, connectionId: conn!.id }, 'initial calendar list fetch failed');
        await deps.db
          .update(staffCalendarConnections)
          .set({ syncError: SYNC_ERROR_CALENDAR_LIST_FAILED, updatedAt: new Date() })
          .where(eq(staffCalendarConnections.id, conn!.id))
          .catch(() => undefined);
      }

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'staff_calendar_connection',
        entityId: conn!.id,
        actorAppUserId: payload.staffId,
        after: { provider, providerEmail: identity.providerEmail },
      });

      // First sync inline (best-effort) so events appear right away
      // instead of waiting for the next 5-min worker heartbeat. The
      // 60s lock mirrors the manual "Sync now" route and dedupes
      // against it; a sync failure must not fail the connect. Skipped
      // when the calendar list fetch failed — there is nothing to sync
      // and a vacuous success would clear that marker.
      if (calendarListOk) {
        try {
          const lockKey = `cal:sync:lock:${conn!.id}`;
          if (!(await deps.stateStore.get(lockKey))) {
            await deps.stateStore.set(lockKey, '1', 60);
            const settings = await getCalendarSettings(deps.db, payload.firmId);
            const fullConn = await loadConnection(deps.db, payload.firmId, conn!.id);
            if (fullConn) {
              await syncConnection(
                {
                  db: deps.db,
                  fetchImpl: doFetch,
                  lookbackDays: settings.lookbackDays,
                  lookaheadDays: settings.lookaheadDays,
                },
                fullConn,
              );
            }
          }
        } catch (err) {
          logger.warn({ err, connectionId: conn!.id }, 'initial calendar sync failed');
        }
      }

      res.redirect(accountUrl('success'));
    } catch (err) {
      logger.error({ err, provider }, 'calendar oauth callback failed');
      // Record the failure on any existing connection for visibility.
      await deps.db
        .update(staffCalendarConnections)
        .set({ syncError: 'auth_failed', updatedAt: new Date() })
        .where(eq(staffCalendarConnections.staffId, payload.staffId))
        .catch(() => undefined);
      res.redirect(accountUrl('error', 'auth_failed'));
    }
  });

  return router;
}
