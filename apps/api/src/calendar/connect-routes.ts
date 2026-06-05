// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-2 — per-staff calendar connect + management (mounted at
// /api/staff/calendar, authed). Self-service: a staff member connects,
// picks calendars, and disconnects their OWN provider accounts. The OAuth
// callback itself is a separate PUBLIC route (public-routes.ts) because the
// SameSite=Strict session cookie doesn't survive the provider redirect.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  calendarProviderConfig,
  staffCalendarConnections,
  staffCalendarSelections,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { logger } from '../logger';
import { buildAuthorizeUrl, listCalendars, revokeToken, type CalendarProvider } from './oauth';
import {
  callbackRedirectUri,
  newState,
  stateKey,
  upsertCalendarList,
  type OAuthStateStore,
} from './connect-shared';
import { getProviderCreds, loadConnection } from './store';
import { ensureFreshAccessToken } from './token-manager';
import { getCalendarSettings } from './settings';
import { syncConnection } from './sync';

export interface CalendarConnectDeps {
  db: Database | null;
  stateStore: OAuthStateStore;
  /** Base origin for the OAuth redirect URI (must match the registered URI). */
  redirectBase: string;
  fetchImpl?: typeof fetch;
}

const PROVIDERS = ['microsoft', 'google'] as const;
function isProvider(v: string): v is CalendarProvider {
  return (PROVIDERS as readonly string[]).includes(v);
}

const SelectionsSchema = z.object({
  selections: z
    .array(z.object({ calendarId: z.string(), syncEnabled: z.boolean() }))
    .min(1)
    .max(100),
});

export function createCalendarConnectRouter(deps: CalendarConnectDeps): Router {
  const router = express.Router();
  const doFetch = deps.fetchImpl ?? fetch;

  // GET /providers — providers enabled for the firm + this staff's
  // connection status per provider.
  router.get('/providers', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    const staffId = req.staffSession!.appUserId;
    if (!deps.db) {
      res.json({ providers: [] });
      return;
    }
    const [configs, conns] = await Promise.all([
      deps.db
        .select({
          provider: calendarProviderConfig.provider,
          enabled: calendarProviderConfig.enabled,
        })
        .from(calendarProviderConfig)
        .where(eq(calendarProviderConfig.firmId, firmId)),
      deps.db
        .select()
        .from(staffCalendarConnections)
        .where(eq(staffCalendarConnections.staffId, staffId)),
    ]);
    const connByProvider = new Map(conns.map((c) => [c.provider, c]));
    res.json({
      providers: PROVIDERS.map((p) => {
        const cfg = configs.find((c) => c.provider === p);
        const conn = connByProvider.get(p);
        return {
          provider: p,
          available: Boolean(cfg?.enabled),
          connected: Boolean(conn),
          providerEmail: conn?.providerEmail ?? null,
          syncError: conn?.syncError ?? null,
          lastSyncedAt: conn?.lastSyncedAt ?? null,
        };
      }),
    });
  });

  // POST /connect/:provider — begin OAuth; returns the authorize URL.
  router.post('/connect/:provider', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    const staffId = req.staffSession!.appUserId;
    const provider = req.params['provider']!;
    if (!isProvider(provider)) {
      res.status(400).json({ error: 'unknown_provider' });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const creds = await getProviderCreds(deps.db, firmId, provider);
    if (!creds || !creds.enabled) {
      res.status(409).json({ error: 'provider_not_enabled' });
      return;
    }
    const state = newState();
    await deps.stateStore.set(stateKey(state), JSON.stringify({ staffId, firmId, provider }), 600);
    const authorizeUrl = buildAuthorizeUrl(provider, {
      clientId: creds.clientId,
      tenantId: creds.tenantId,
      redirectUri: callbackRedirectUri(deps.redirectBase, provider),
      state,
    });
    res.json({ authorizeUrl });
  });

  // GET /connections — this staff's connections + their calendar selections.
  router.get('/connections', async (req: Request, res: Response) => {
    const staffId = req.staffSession!.appUserId;
    if (!deps.db) {
      res.json({ connections: [] });
      return;
    }
    const conns = await deps.db
      .select({
        id: staffCalendarConnections.id,
        provider: staffCalendarConnections.provider,
        providerEmail: staffCalendarConnections.providerEmail,
        enabled: staffCalendarConnections.enabled,
        syncError: staffCalendarConnections.syncError,
        lastSyncedAt: staffCalendarConnections.lastSyncedAt,
        connectedAt: staffCalendarConnections.connectedAt,
      })
      .from(staffCalendarConnections)
      .where(eq(staffCalendarConnections.staffId, staffId));
    const ids = conns.map((c) => c.id);
    const allSelections = ids.length
      ? await deps.db
          .select()
          .from(staffCalendarSelections)
          .where(inArray(staffCalendarSelections.connectionId, ids))
      : [];
    res.json({
      connections: conns.map((c) => ({
        ...c,
        selections: allSelections.filter((s) => s.connectionId === c.id),
      })),
    });
  });

  // PATCH /connections/:id/selections — set which calendars sync.
  router.patch('/connections/:id/selections', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    const staffId = req.staffSession!.appUserId;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = SelectionsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const conn = await loadConnection(deps.db, firmId, req.params['id']!);
    if (!conn || conn.staffId !== staffId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    for (const sel of parsed.data.selections) {
      await deps.db
        .update(staffCalendarSelections)
        .set({ syncEnabled: sel.syncEnabled, updatedAt: new Date() })
        .where(
          and(
            eq(staffCalendarSelections.connectionId, conn.id),
            eq(staffCalendarSelections.calendarId, sel.calendarId),
          ),
        );
    }
    res.json({ ok: true });
  });

  // POST /connections/:id/refresh-calendars — re-fetch the calendar list.
  router.post('/connections/:id/refresh-calendars', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    const staffId = req.staffSession!.appUserId;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const conn = await loadConnection(deps.db, firmId, req.params['id']!);
    if (!conn || conn.staffId !== staffId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const creds = await getProviderCreds(deps.db, firmId, conn.provider as CalendarProvider);
    if (!creds) {
      res.status(409).json({ error: 'provider_not_configured' });
      return;
    }
    try {
      const token = await ensureFreshAccessToken(deps.db, conn, creds, doFetch);
      const calendars = await listCalendars(conn.provider as CalendarProvider, token, doFetch);
      await upsertCalendarList(deps.db, conn.id, calendars);
      res.json({ ok: true, count: calendars.length });
    } catch (err) {
      logger.warn({ err, connectionId: conn.id }, 'calendar refresh failed');
      res.status(502).json({ error: 'refresh_failed' });
    }
  });

  // GET /connections/:id/status — for the "Sync Now" spinner poll.
  router.get('/connections/:id/status', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    const staffId = req.staffSession!.appUserId;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const conn = await loadConnection(deps.db, firmId, req.params['id']!);
    if (!conn || conn.staffId !== staffId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      lastSyncedAt: conn.lastSyncedAt,
      syncError: conn.syncError,
      enabled: conn.enabled,
    });
  });

  // POST /connections/:id/sync — staff-triggered manual sync (rate-limited
  // 1/60s). Runs inline (one connection, bounded) and returns the result.
  router.post('/connections/:id/sync', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    const staffId = req.staffSession!.appUserId;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const conn = await loadConnection(deps.db, firmId, req.params['id']!);
    if (!conn || conn.staffId !== staffId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const lockKey = `cal:sync:lock:${conn.id}`;
    if (await deps.stateStore.get(lockKey)) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    await deps.stateStore.set(lockKey, '1', 60);
    try {
      const settings = await getCalendarSettings(deps.db, firmId);
      const outcome = await syncConnection(
        {
          db: deps.db,
          fetchImpl: doFetch,
          lookbackDays: settings.lookbackDays,
          lookaheadDays: settings.lookaheadDays,
        },
        conn,
      );
      res.status(202).json(outcome);
    } catch (err) {
      logger.warn({ err, connectionId: conn.id }, 'manual calendar sync failed');
      res.status(502).json({ error: 'sync_failed' });
    }
  });

  // DELETE /connections/:id — disconnect (revoke best-effort, keep events).
  router.delete('/connections/:id', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    const staffId = req.staffSession!.appUserId;
    const actor = req.staffSession!.appUserId;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const conn = await loadConnection(deps.db, firmId, req.params['id']!);
    if (!conn || conn.staffId !== staffId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Best-effort revoke (Google).
    try {
      const { decryptConnectionTokens } = await import('./store');
      const tokens = decryptConnectionTokens(deps.db, firmId, conn);
      if (tokens.refreshToken) {
        await revokeToken(conn.provider as CalendarProvider, tokens.refreshToken, doFetch);
      }
    } catch {
      // ignore
    }
    // Deleting the connection cascades selections; calendar_events keep
    // history (connection_id → null via ON DELETE SET NULL).
    await deps.db.delete(staffCalendarConnections).where(eq(staffCalendarConnections.id, conn.id));
    await emitAudit(deps.db, {
      action: 'ARCHIVE',
      entityType: 'staff_calendar_connection',
      entityId: conn.id,
      actorAppUserId: actor,
      before: { provider: conn.provider, providerEmail: conn.providerEmail },
    });
    res.json({ ok: true });
  });

  return router;
}
