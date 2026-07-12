// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0207 — pause-and-hold stopwatch timers. A timer is durable working
// state (Postgres, not Redis — it's unbilled revenue): one RUNNING timer
// per user, any number PAUSED. Starting or resuming a timer auto-pauses
// whichever one is running. Timers can start blank and be classified
// (client/engagement/work code) while running; an engagement is required
// only at save, when the timer converts to a normal time_entry through
// createTimeEntryCore — the exact same guards as manual logging (rate
// snapshot, lifecycle, retainer lock, late-entry lockout, NTE cap). If
// the save is rejected, the timer stays PAUSED so the time is never lost.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagements, timeEntries, timeTimers, workCodes } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission } from '../auth/rbac-middleware';
import { pgErrorCode } from '../db-error';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { CreateSchema, createTimeEntryCore, type TimeEntryRoutesDeps } from './routes';

// Forgotten-timer guardrail: a RUNNING segment older than this is
// auto-paused (lazily, on the next read or mutation — no worker sweep).
// The full elapsed time is kept; the user reviews it before saving.
export const TIMER_AUTO_PAUSE_SECONDS = 8 * 3600;
// Parking-lot cap. Ten parked timers means the user has stopped logging,
// not started multitasking; refuse an eleventh.
const MAX_TIMERS_PER_USER = 10;

const TimerStartSchema = z.object({
  clientId: z.string().uuid().optional(),
  engagementId: z.string().uuid().optional(),
  workCodeId: z.string().uuid().optional(),
  description: z.string().max(2000).optional(),
  // 0209 — the logged entry a ▶ continue was pressed on; the time views
  // use it to mark that row as running.
  sourceTimeEntryId: z.string().uuid().optional(),
  // 0211 — carried from the source entry so save defaults match the row
  // the timer was continued from (non-billable stays non-billable).
  billableFlag: z.boolean().optional(),
  outOfScopeOverride: z.boolean().optional(),
});

const TimerPatchSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
  engagementId: z.string().uuid().nullable().optional(),
  workCodeId: z.string().uuid().nullable().optional(),
  description: z.string().max(2000).optional(),
  // Corrects the tracked time ("the call started five minutes before I
  // hit start"). Replaces the accumulated total as of now.
  elapsedSeconds: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600)
    .optional(),
});

const TimerSaveSchema = z.object({
  engagementId: z.string().uuid().optional(),
  workCodeId: z.string().uuid().optional(),
  entryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  hours: z.number().positive().max(24).optional(),
  description: z.string().max(2000).optional(),
  billableFlag: z.boolean().optional(),
  outOfScopeOverride: z.boolean().optional(),
  workflowState: z.string().min(1).max(120).optional(),
});

type TimerRow = typeof timeTimers.$inferSelect;

function clientIp(req: Request): string {
  return (req.headers?.['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

function elapsedSecondsOf(row: TimerRow, now: Date): number {
  const running =
    row.status === 'RUNNING' && row.lastStartedAt
      ? Math.max(0, Math.floor((now.getTime() - row.lastStartedAt.getTime()) / 1000))
      : 0;
  return row.accumulatedSeconds + running;
}

/** Exact elapsed → decimal hours at the time_entry's numeric(6,2) grain.
 *  No rounding to a billing increment (user decision — Q19's free-decimal
 *  lane); floor of 0.01 satisfies the hours > 0 CHECK for sub-18s timers. */
export function elapsedToHours(elapsedSeconds: number): number {
  return Math.max(0.01, Math.round((elapsedSeconds / 3600) * 100) / 100);
}

export function createTimerRouter(deps: TimeEntryRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
  type DbLike = Database | Tx;

  /** Accumulate the running segment and park the row. */
  async function pauseRow(db: DbLike, row: TimerRow, now: Date, auto: boolean): Promise<void> {
    await db
      .update(timeTimers)
      .set({
        status: 'PAUSED',
        accumulatedSeconds: elapsedSecondsOf(row, now),
        lastStartedAt: null,
        ...(auto ? { autoPausedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(timeTimers.id, row.id));
  }

  /** Pause whichever timer is RUNNING for this user (if any). */
  async function pauseRunning(
    db: DbLike,
    appUserId: string,
    now: Date,
    exceptId?: string,
  ): Promise<void> {
    const [running] = await db
      .select()
      .from(timeTimers)
      .where(and(eq(timeTimers.appUserId, appUserId), eq(timeTimers.status, 'RUNNING')))
      .limit(1);
    if (running && running.id !== exceptId) await pauseRow(db, running, now, false);
  }

  /** Forgotten-timer guardrail, applied lazily on read/mutation. */
  async function applyAutoPause(db: Database, appUserId: string, now: Date): Promise<void> {
    const [running] = await db
      .select()
      .from(timeTimers)
      .where(and(eq(timeTimers.appUserId, appUserId), eq(timeTimers.status, 'RUNNING')))
      .limit(1);
    if (!running || !running.lastStartedAt) return;
    const segment = (now.getTime() - running.lastStartedAt.getTime()) / 1000;
    if (segment > TIMER_AUTO_PAUSE_SECONDS) await pauseRow(db, running, now, true);
  }

  /** Full timer list DTO for the caller — every response returns this so
   *  the client replaces state wholesale and never merges. */
  async function listPayload(db: Database, appUserId: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const rows = await db
      .select({
        timer: timeTimers,
        clientName: clients.name,
        engagementName: engagements.name,
        workCodeName: workCodes.name,
      })
      .from(timeTimers)
      .leftJoin(clients, eq(timeTimers.clientId, clients.id))
      .leftJoin(engagements, eq(timeTimers.engagementId, engagements.id))
      .leftJoin(workCodes, eq(timeTimers.workCodeId, workCodes.id))
      .where(eq(timeTimers.appUserId, appUserId));
    const items = rows
      .map((r) => ({
        id: r.timer.id,
        clientId: r.timer.clientId,
        engagementId: r.timer.engagementId,
        workCodeId: r.timer.workCodeId,
        sourceTimeEntryId: r.timer.sourceTimeEntryId,
        billableFlag: r.timer.billableFlag,
        outOfScopeOverride: r.timer.outOfScopeOverride,
        clientName: r.clientName,
        engagementName: r.engagementName,
        workCodeName: r.workCodeName,
        description: r.timer.description,
        status: r.timer.status,
        elapsedSeconds: elapsedSecondsOf(r.timer, now),
        lastStartedAt: r.timer.lastStartedAt?.toISOString() ?? null,
        startedAt: r.timer.startedAt.toISOString(),
        autoPausedAt: r.timer.autoPausedAt?.toISOString() ?? null,
        updatedAt: r.timer.updatedAt.toISOString(),
      }))
      .sort((a, b) =>
        a.status === b.status
          ? b.updatedAt.localeCompare(a.updatedAt)
          : a.status === 'RUNNING'
            ? -1
            : 1,
      );
    return { items, serverTime: now.toISOString() };
  }

  /** Load a timer owned by the caller. */
  async function ownTimer(
    db: Database,
    appUserId: string,
    id: string,
  ): Promise<TimerRow | undefined> {
    const [row] = await db
      .select()
      .from(timeTimers)
      .where(and(eq(timeTimers.id, id), eq(timeTimers.appUserId, appUserId)))
      .limit(1);
    return row;
  }

  /** Engagement must exist and belong to the firm; returns its clientId
   *  so classification backfills the client hint. */
  async function resolveEngagement(
    db: Database,
    firmId: string,
    engagementId: string,
  ): Promise<{ clientId: string } | null> {
    const [row] = await db
      .select({ clientId: engagements.clientId, firmId: clients.firmId })
      .from(engagements)
      .innerJoin(clients, eq(engagements.clientId, clients.id))
      .where(eq(engagements.id, engagementId))
      .limit(1);
    if (!row || row.firmId !== firmId) return null;
    return { clientId: row.clientId };
  }

  /** Work code must exist and belong to the firm — validated up-front so a
   *  bad id 404s instead of surfacing as an FK-violation 500. */
  async function workCodeExists(
    db: Database,
    firmId: string,
    workCodeId: string,
  ): Promise<boolean> {
    const [row] = await db
      .select({ firmId: workCodes.firmId })
      .from(workCodes)
      .where(eq(workCodes.id, workCodeId))
      .limit(1);
    return !!row && row.firmId === firmId;
  }

  /** Source entry must exist and belong to the firm (same rationale). */
  async function timeEntryExists(
    db: Database,
    firmId: string,
    timeEntryId: string,
  ): Promise<boolean> {
    const [row] = await db
      .select({ firmId: clients.firmId })
      .from(timeEntries)
      .innerJoin(engagements, eq(timeEntries.engagementId, engagements.id))
      .innerJoin(clients, eq(engagements.clientId, clients.id))
      .where(eq(timeEntries.id, timeEntryId))
      .limit(1);
    return !!row && row.firmId === firmId;
  }

  /** Client must exist and belong to the firm (same rationale). */
  async function clientExists(db: Database, firmId: string, clientId: string): Promise<boolean> {
    const [row] = await db
      .select({ firmId: clients.firmId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    return !!row && row.firmId === firmId;
  }

  async function auditTimer(
    req: Request,
    args: {
      action: 'CREATE' | 'UPDATE' | 'ARCHIVE';
      id: string;
      before?: unknown;
      after?: unknown;
    },
  ): Promise<void> {
    if (!deps.db) return;
    await emitAudit(deps.db, {
      action: args.action,
      entityType: 'time_timer',
      entityId: args.id,
      actorAppUserId: req.staffSession!.appUserId,
      before: args.before,
      after: args.after,
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed (time_timer)'));
  }

  // ---------------------------------------------------------------

  router.get(
    '/',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], serverTime: new Date().toISOString() });
        return;
      }
      await applyAutoPause(deps.db, session.appUserId, new Date());
      res.json(await listPayload(deps.db, session.appUserId));
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const parsed = TimerStartSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ items: [], serverTime: new Date().toISOString() });
        return;
      }
      const db = deps.db;

      let clientId = parsed.data.clientId ?? null;
      if (parsed.data.engagementId) {
        const eng = await resolveEngagement(db, session.firmId, parsed.data.engagementId);
        if (!eng) {
          res.status(404).json({ error: 'engagement_not_found' });
          return;
        }
        clientId = eng.clientId;
      } else if (clientId) {
        if (!(await clientExists(db, session.firmId, clientId))) {
          res.status(404).json({ error: 'client_not_found' });
          return;
        }
      }
      if (
        parsed.data.workCodeId &&
        !(await workCodeExists(db, session.firmId, parsed.data.workCodeId))
      ) {
        res.status(404).json({ error: 'work_code_not_found' });
        return;
      }
      if (
        parsed.data.sourceTimeEntryId &&
        !(await timeEntryExists(db, session.firmId, parsed.data.sourceTimeEntryId))
      ) {
        res.status(404).json({ error: 'time_entry_not_found' });
        return;
      }

      const existing = await db
        .select({ id: timeTimers.id })
        .from(timeTimers)
        .where(eq(timeTimers.appUserId, session.appUserId));
      if (existing.length >= MAX_TIMERS_PER_USER) {
        res.status(409).json({ error: 'timer_limit', max: MAX_TIMERS_PER_USER });
        return;
      }

      const now = new Date();
      let inserted: { id: string } | undefined;
      try {
        inserted = await db.transaction(async (tx) => {
          await pauseRunning(tx, session.appUserId, now);
          const [row] = await tx
            .insert(timeTimers)
            .values({
              appUserId: session.appUserId,
              clientId,
              engagementId: parsed.data.engagementId ?? null,
              workCodeId: parsed.data.workCodeId ?? null,
              sourceTimeEntryId: parsed.data.sourceTimeEntryId ?? null,
              billableFlag: parsed.data.billableFlag ?? null,
              outOfScopeOverride: parsed.data.outOfScopeOverride ?? null,
              description: parsed.data.description ?? '',
              status: 'RUNNING',
              accumulatedSeconds: 0,
              lastStartedAt: now,
              startedAt: now,
            })
            .returning({ id: timeTimers.id });
          return row;
        });
      } catch (err) {
        // 23505 on the single-RUNNING partial index: a concurrent request
        // (second tab) started a timer between our pause and insert. The
        // client resyncs from the conflict response's list.
        if (pgErrorCode(err) === '23505') {
          res.status(409).json({
            error: 'timer_conflict',
            ...(await listPayload(db, session.appUserId)),
          });
          return;
        }
        throw err;
      }

      await auditTimer(req, {
        action: 'CREATE',
        id: inserted!.id,
        after: {
          clientId,
          engagementId: parsed.data.engagementId ?? null,
          workCodeId: parsed.data.workCodeId ?? null,
        },
      });
      res
        .status(201)
        .json({ startedId: inserted!.id, ...(await listPayload(db, session.appUserId)) });
    },
  );

  router.post(
    '/:id/pause',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], serverTime: new Date().toISOString() });
        return;
      }
      const row = await ownTimer(deps.db, session.appUserId, req.params['id']!);
      if (!row) {
        res.status(404).json({ error: 'timer_not_found' });
        return;
      }
      if (row.status !== 'RUNNING') {
        res.status(409).json({ error: 'not_running' });
        return;
      }
      await pauseRow(deps.db, row, new Date(), false);
      await auditTimer(req, { action: 'UPDATE', id: row.id, after: { status: 'PAUSED' } });
      res.json(await listPayload(deps.db, session.appUserId));
    },
  );

  router.post(
    '/:id/resume',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], serverTime: new Date().toISOString() });
        return;
      }
      const db = deps.db;
      const row = await ownTimer(db, session.appUserId, req.params['id']!);
      if (!row) {
        res.status(404).json({ error: 'timer_not_found' });
        return;
      }
      const now = new Date();
      if (row.status !== 'RUNNING') {
        try {
          await db.transaction(async (tx) => {
            await pauseRunning(tx, session.appUserId, now, row.id);
            await tx
              .update(timeTimers)
              .set({ status: 'RUNNING', lastStartedAt: now, autoPausedAt: null, updatedAt: now })
              .where(eq(timeTimers.id, row.id));
          });
        } catch (err) {
          // Concurrent resume/start from another tab won the RUNNING slot.
          if (pgErrorCode(err) === '23505') {
            res.status(409).json({
              error: 'timer_conflict',
              ...(await listPayload(db, session.appUserId)),
            });
            return;
          }
          throw err;
        }
        await auditTimer(req, { action: 'UPDATE', id: row.id, after: { status: 'RUNNING' } });
      }
      res.json(await listPayload(db, session.appUserId));
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const parsed = TimerPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], serverTime: new Date().toISOString() });
        return;
      }
      const db = deps.db;
      const row = await ownTimer(db, session.appUserId, req.params['id']!);
      if (!row) {
        res.status(404).json({ error: 'timer_not_found' });
        return;
      }

      const now = new Date();
      const patch: Partial<typeof timeTimers.$inferInsert> = { updatedAt: now };
      if (parsed.data.engagementId !== undefined) {
        if (parsed.data.engagementId === null) {
          patch.engagementId = null;
        } else {
          const eng = await resolveEngagement(db, session.firmId, parsed.data.engagementId);
          if (!eng) {
            res.status(404).json({ error: 'engagement_not_found' });
            return;
          }
          patch.engagementId = parsed.data.engagementId;
          patch.clientId = eng.clientId;
        }
      }
      if (parsed.data.clientId !== undefined && patch.clientId === undefined) {
        if (
          parsed.data.clientId !== null &&
          !(await clientExists(db, session.firmId, parsed.data.clientId))
        ) {
          res.status(404).json({ error: 'client_not_found' });
          return;
        }
        patch.clientId = parsed.data.clientId;
      }
      if (parsed.data.workCodeId !== undefined) {
        if (
          parsed.data.workCodeId !== null &&
          !(await workCodeExists(db, session.firmId, parsed.data.workCodeId))
        ) {
          res.status(404).json({ error: 'work_code_not_found' });
          return;
        }
        patch.workCodeId = parsed.data.workCodeId;
      }
      if (parsed.data.description !== undefined) patch.description = parsed.data.description;
      if (parsed.data.elapsedSeconds !== undefined) {
        // Replace tracked time as of now: the running segment restarts.
        patch.accumulatedSeconds = parsed.data.elapsedSeconds;
        if (row.status === 'RUNNING') patch.lastStartedAt = now;
      }

      await db.update(timeTimers).set(patch).where(eq(timeTimers.id, row.id));
      await auditTimer(req, {
        action: 'UPDATE',
        id: row.id,
        before: {
          engagementId: row.engagementId,
          workCodeId: row.workCodeId,
          accumulatedSeconds: row.accumulatedSeconds,
        },
        after: parsed.data,
      });
      res.json(await listPayload(db, session.appUserId));
    },
  );

  router.post(
    '/:id/save',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const parsed = TimerSaveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ items: [], serverTime: new Date().toISOString() });
        return;
      }
      const db = deps.db;

      // The whole save runs in ONE transaction with the timer row locked
      // (FOR UPDATE): two tabs clicking ✓ at once serialize, the loser sees
      // the row gone and 404s instead of double-logging the time; a
      // concurrent discard can't slip between create and delete either.
      const now = new Date();
      const outcome = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Database;
        const [row] = await tx
          .select()
          .from(timeTimers)
          .where(
            and(eq(timeTimers.id, req.params['id']!), eq(timeTimers.appUserId, session.appUserId)),
          )
          .for('update')
          .limit(1);
        if (!row) {
          return { status: 404, body: { error: 'timer_not_found' } as Record<string, unknown> };
        }

        // Park the timer first (persists even if the create below is
        // rejected — the time survives as a PAUSED timer).
        if (row.status === 'RUNNING') await pauseRow(tx, row, now, false);
        const elapsedSeconds = elapsedSecondsOf(row, now);

        const engagementId = parsed.data.engagementId ?? row.engagementId;
        if (!engagementId) {
          return { status: 400, body: { error: 'engagement_required' }, elapsedSeconds };
        }
        if (
          parsed.data.workCodeId &&
          !(await workCodeExists(txDb, session.firmId, parsed.data.workCodeId))
        ) {
          return { status: 404, body: { error: 'work_code_not_found' }, elapsedSeconds };
        }

        const payload = {
          engagementId,
          workCodeId: parsed.data.workCodeId ?? row.workCodeId ?? undefined,
          entryDate: parsed.data.entryDate ?? now.toISOString().slice(0, 10),
          hours: parsed.data.hours ?? elapsedToHours(elapsedSeconds),
          description: parsed.data.description ?? (row.description || undefined),
          // 0211 — the timer's carried flags fill in when the save payload
          // doesn't say (a ▶-continued non-billable row stays non-billable).
          billableFlag: parsed.data.billableFlag ?? row.billableFlag ?? undefined,
          outOfScopeOverride: parsed.data.outOfScopeOverride ?? row.outOfScopeOverride ?? undefined,
          workflowState: parsed.data.workflowState,
        };
        // Re-validate through the create schema so the core sees exactly
        // what a manual POST would (e.g. hours ≤ 24 on a marathon timer).
        const createParsed = CreateSchema.safeParse(payload);
        if (!createParsed.success) {
          return {
            status: 400,
            body: {
              error: 'invalid_payload',
              detail: createParsed.error.flatten(),
            } as Record<string, unknown>,
            elapsedSeconds,
          };
        }

        const result = await createTimeEntryCore(
          { ...deps, db: txDb },
          {
            session,
            payload: createParsed.data,
            ip: clientIp(req),
            userAgent: req.header('user-agent') ?? null,
          },
        );
        if (result.status !== 201) {
          // Timer already parked above; nothing is lost.
          return { ...result, elapsedSeconds };
        }

        await tx.delete(timeTimers).where(eq(timeTimers.id, row.id));
        return {
          status: 201,
          body: result.body,
          elapsedSeconds,
          savedTimerId: row.id,
          savedHours: createParsed.data.hours,
        };
      });

      if (outcome.status !== 201 || !('savedTimerId' in outcome)) {
        res.status(outcome.status).json(outcome.body);
        return;
      }
      await auditTimer(req, {
        action: 'ARCHIVE',
        id: outcome.savedTimerId!,
        after: {
          disposition: 'saved',
          timeEntryId: outcome.body['id'],
          elapsedSeconds: outcome.elapsedSeconds,
          hours: outcome.savedHours,
        },
      });
      res.status(201).json({
        ...outcome.body,
        timerId: outcome.savedTimerId,
        elapsedSeconds: outcome.elapsedSeconds,
        ...(await listPayload(db, session.appUserId)),
      });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], serverTime: new Date().toISOString() });
        return;
      }
      const row = await ownTimer(deps.db, session.appUserId, req.params['id']!);
      if (!row) {
        res.status(404).json({ error: 'timer_not_found' });
        return;
      }
      const elapsedSeconds = elapsedSecondsOf(row, new Date());
      await deps.db.delete(timeTimers).where(eq(timeTimers.id, row.id));
      await auditTimer(req, {
        action: 'ARCHIVE',
        id: row.id,
        after: { disposition: 'discarded', elapsedSeconds },
      });
      res.json(await listPayload(deps.db, session.appUserId));
    },
  );

  return router;
}
