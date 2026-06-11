// SPDX-License-Identifier: Elastic-2.0
//
// CAL-2 — per-staff calendar connect + management (mounted at
// /api/staff/calendar, authed). Self-service: a staff member connects,
// picks calendars, and disconnects their OWN provider accounts. The OAuth
// callback itself is a separate PUBLIC route (public-routes.ts) because the
// SameSite=Strict session cookie doesn't survive the provider redirect.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  calendarEventMatches,
  calendarEvents,
  clients,
  calendarProviderConfig,
  staffCalendarConnections,
  staffCalendarSelections,
  staffTimeSuggestionLog,
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
import { applianceProviderAvailable, getProviderCreds, loadConnection } from './store';
import { ensureFreshAccessToken } from './token-manager';
import { getCalendarSettings } from './settings';
import { syncConnection } from './sync';
import {
  CalendarWriteError,
  CalendarWriteService,
  isCalendarWriteEnabled,
  type WriteEventInput,
} from './write-service';

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
          // Available if the firm enabled its own app OR the appliance has an
          // env-level OAuth app (CAL-2) — staff just sign in either way.
          available: Boolean(cfg?.enabled) || applianceProviderAvailable(p),
          connected: Boolean(conn),
          providerEmail: conn?.providerEmail ?? null,
          syncError: conn?.syncError ?? null,
          lastSyncedAt: conn?.lastSyncedAt ?? null,
        };
      }),
    });
  });

  // GET /events/my?view=today|week — this staff's upcoming appointments
  // with resolved match + client name (for the dashboard panel).
  router.get('/events/my', async (req: Request, res: Response) => {
    const staffId = req.staffSession!.appUserId;
    if (!deps.db) {
      res.json({ events: [] });
      return;
    }
    const view = String(req.query['view'] ?? 'today');
    const now = new Date();
    let start: Date;
    let end: Date;
    if (view === 'week') {
      start = now;
      end = new Date(now.getTime() + 7 * 86400_000);
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      end = new Date(start.getTime() + 86400_000);
    }

    const rows = await deps.db
      .select({
        id: calendarEvents.id,
        subject: calendarEvents.subject,
        startAt: calendarEvents.startAt,
        endAt: calendarEvents.endAt,
        location: calendarEvents.location,
        webLink: calendarEvents.webLink,
        provider: staffCalendarConnections.provider,
      })
      .from(calendarEvents)
      .leftJoin(
        staffCalendarConnections,
        eq(staffCalendarConnections.id, calendarEvents.connectionId),
      )
      .where(
        and(
          eq(calendarEvents.staffId, staffId),
          isNull(calendarEvents.softDeletedAt),
          gte(calendarEvents.startAt, start),
          lt(calendarEvents.startAt, end),
        ),
      )
      .orderBy(asc(calendarEvents.startAt))
      .limit(200);

    const eventIds = rows.map((r) => r.id);
    const matches = eventIds.length
      ? await deps.db
          .select({
            eventId: calendarEventMatches.eventId,
            status: calendarEventMatches.matchStatus,
            tier: calendarEventMatches.matchTier,
            clientId: calendarEventMatches.clientId,
            clientName: clients.name,
          })
          .from(calendarEventMatches)
          .leftJoin(clients, eq(clients.id, calendarEventMatches.clientId))
          .where(inArray(calendarEventMatches.eventId, eventIds))
      : [];
    // One match per event: prefer confirmed.
    const byEvent = new Map<string, (typeof matches)[number]>();
    for (const m of matches) {
      const cur = byEvent.get(m.eventId);
      if (!cur || (m.status === 'confirmed' && cur.status !== 'confirmed'))
        byEvent.set(m.eventId, m);
    }

    res.json({
      events: rows.map((r) => {
        const m = byEvent.get(r.id);
        return {
          ...r,
          matchStatus: m?.status ?? null,
          matchTier: m?.tier ?? null,
          clientId: m?.clientId ?? null,
          clientName: m?.clientName ?? null,
        };
      }),
    });
  });

  // CAL-9 — write-back (two-way sync). Gated behind FEATURE_CALENDAR_WRITE;
  // returns 501 while the flag is off (see docs/calendar-writeback-v2.md).
  const writeService = new CalendarWriteService();

  const WRITE_ERROR_STATUS: Record<CalendarWriteError['code'], number> = {
    write_disabled: 501,
    not_found: 404,
    not_configured: 409,
    write_scope_missing: 409,
    reauth_required: 409,
    provider_failed: 502,
  };

  function handleWriteError(err: unknown, res: Response, connectionId?: string): void {
    if (err instanceof CalendarWriteError) {
      res.status(WRITE_ERROR_STATUS[err.code]).json({ error: err.code });
      return;
    }
    logger.warn({ err, connectionId }, 'calendar write-back failed');
    res.status(502).json({ error: 'write_failed' });
  }

  function writeGuard(res: Response): boolean {
    if (!isCalendarWriteEnabled()) {
      res.status(501).json({ error: 'calendar_write_not_enabled' });
      return false;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return false;
    }
    return true;
  }

  const CreateEventSchema = z.object({
    connectionId: z.string().uuid(),
    calendarId: z.string().min(1),
    title: z.string().min(1).max(500),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    location: z.string().max(1000).nullish(),
    attendees: z.array(z.string().email()).max(100).optional(),
  });

  const UpdateEventSchema = z
    .object({
      title: z.string().min(1).max(500).optional(),
      start: z.string().datetime({ offset: true }).optional(),
      end: z.string().datetime({ offset: true }).optional(),
      location: z.string().max(1000).nullish(),
      attendees: z.array(z.string().email()).max(100).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'empty_patch' });

  // POST /events — create a TB-origin event on a connected calendar.
  router.post('/events', async (req: Request, res: Response) => {
    if (!writeGuard(res)) return;
    const parsed = CreateEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', issues: parsed.error.flatten() });
      return;
    }
    const start = new Date(parsed.data.start);
    const end = new Date(parsed.data.end);
    if (end.getTime() <= start.getTime()) {
      res.status(400).json({ error: 'ends_before_starts' });
      return;
    }
    const input: WriteEventInput = {
      title: parsed.data.title,
      start,
      end,
      location: parsed.data.location ?? null,
      attendees: parsed.data.attendees ?? [],
    };
    try {
      const out = await writeService.createEvent(
        { db: deps.db!, fetchImpl: doFetch },
        {
          firmId: req.staffSession!.firmId,
          staffId: req.staffSession!.appUserId,
          connectionId: parsed.data.connectionId,
          calendarId: parsed.data.calendarId,
          input,
          actorAppUserId: req.staffSession!.appUserId,
        },
      );
      res.status(201).json(out);
    } catch (err) {
      handleWriteError(err, res, parsed.data.connectionId);
    }
  });

  // PATCH /events/:id — update a TB-origin event we own.
  router.patch('/events/:id', async (req: Request, res: Response) => {
    if (!writeGuard(res)) return;
    const parsed = UpdateEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', issues: parsed.error.flatten() });
      return;
    }
    const patch: Partial<WriteEventInput> = {};
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.start !== undefined) patch.start = new Date(parsed.data.start);
    if (parsed.data.end !== undefined) patch.end = new Date(parsed.data.end);
    if (parsed.data.location !== undefined) patch.location = parsed.data.location ?? null;
    if (parsed.data.attendees !== undefined) patch.attendees = parsed.data.attendees;
    if (patch.start && patch.end && patch.end.getTime() <= patch.start.getTime()) {
      res.status(400).json({ error: 'ends_before_starts' });
      return;
    }
    try {
      await writeService.updateEvent(
        { db: deps.db!, fetchImpl: doFetch },
        {
          firmId: req.staffSession!.firmId,
          staffId: req.staffSession!.appUserId,
          eventId: req.params['id']!,
          patch,
          actorAppUserId: req.staffSession!.appUserId,
        },
      );
      res.json({ ok: true });
    } catch (err) {
      handleWriteError(err, res);
    }
  });

  // DELETE /events/:id — delete a TB-origin event we own.
  router.delete('/events/:id', async (req: Request, res: Response) => {
    if (!writeGuard(res)) return;
    try {
      await writeService.deleteEvent(
        { db: deps.db!, fetchImpl: doFetch },
        {
          firmId: req.staffSession!.firmId,
          staffId: req.staffSession!.appUserId,
          eventId: req.params['id']!,
          actorAppUserId: req.staffSession!.appUserId,
        },
      );
      res.json({ ok: true });
    } catch (err) {
      handleWriteError(err, res);
    }
  });

  // GET /suggestions — pending time-entry suggestions for this staff.
  router.get('/suggestions', async (req: Request, res: Response) => {
    const staffId = req.staffSession!.appUserId;
    if (!deps.db) {
      res.json({ suggestions: [] });
      return;
    }
    const now = new Date();
    const rows = await deps.db
      .select({
        id: staffTimeSuggestionLog.id,
        eventId: calendarEvents.id,
        subject: calendarEvents.subject,
        startAt: calendarEvents.startAt,
        endAt: calendarEvents.endAt,
        clientId: calendarEventMatches.clientId,
        clientName: clients.name,
      })
      .from(staffTimeSuggestionLog)
      .innerJoin(calendarEvents, eq(calendarEvents.id, staffTimeSuggestionLog.eventId))
      .leftJoin(
        calendarEventMatches,
        and(
          eq(calendarEventMatches.eventId, calendarEvents.id),
          eq(calendarEventMatches.matchStatus, 'confirmed'),
        ),
      )
      .leftJoin(clients, eq(clients.id, calendarEventMatches.clientId))
      .where(
        and(
          eq(staffTimeSuggestionLog.staffId, staffId),
          or(
            eq(staffTimeSuggestionLog.action, 'pending'),
            and(
              eq(staffTimeSuggestionLog.action, 'snoozed'),
              lte(staffTimeSuggestionLog.snoozedUntil, now),
            ),
          ),
        ),
      )
      .orderBy(asc(calendarEvents.startAt))
      .limit(20);
    res.json({
      suggestions: rows.map((r) => ({
        ...r,
        durationMinutes:
          r.startAt && r.endAt
            ? Math.max(0, Math.round((r.endAt.getTime() - r.startAt.getTime()) / 60000))
            : 0,
      })),
    });
  });

  // POST /suggestions/:id/dismiss
  router.post('/suggestions/:id/dismiss', async (req: Request, res: Response) => {
    await mutateSuggestion(req, res, { action: 'dismissed' });
  });

  // POST /suggestions/:id/snooze — 1h; auto-dismiss after 3 snoozes.
  router.post('/suggestions/:id/snooze', async (req: Request, res: Response) => {
    const staffId = req.staffSession!.appUserId;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [row] = await deps.db
      .select()
      .from(staffTimeSuggestionLog)
      .where(
        and(
          eq(staffTimeSuggestionLog.id, req.params['id']!),
          eq(staffTimeSuggestionLog.staffId, staffId),
        ),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const count = row.snoozeCount + 1;
    await deps.db
      .update(staffTimeSuggestionLog)
      .set(
        count >= 3
          ? { action: 'dismissed', snoozeCount: count }
          : {
              action: 'snoozed',
              snoozeCount: count,
              snoozedUntil: new Date(Date.now() + 3600_000),
            },
      )
      .where(eq(staffTimeSuggestionLog.id, row.id));
    res.json({ ok: true, autoDismissed: count >= 3 });
  });

  // POST /suggestions/:id/log — link a logged time entry.
  router.post('/suggestions/:id/log', async (req: Request, res: Response) => {
    const timeEntryId =
      typeof req.body?.timeEntryId === 'string' ? (req.body.timeEntryId as string) : null;
    await mutateSuggestion(req, res, { action: 'logged', timeEntryId });
  });

  async function mutateSuggestion(
    req: Request,
    res: Response,
    set: { action: string; timeEntryId?: string | null },
  ): Promise<void> {
    const staffId = req.staffSession!.appUserId;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [row] = await deps.db
      .update(staffTimeSuggestionLog)
      .set(set)
      .where(
        and(
          eq(staffTimeSuggestionLog.id, req.params['id']!),
          eq(staffTimeSuggestionLog.staffId, staffId),
        ),
      )
      .returning({ id: staffTimeSuggestionLog.id });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ok: true });
  }

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
