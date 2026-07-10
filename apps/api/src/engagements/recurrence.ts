// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Engagement recurrence CRUD + run-now. Subscribes a (client ×
// template) to a cadence. Worker (apps/worker/src/jobs/
// recurring-engagement.ts) does the daily sweep that calls
// spawnNextEngagement on each due recurrence; this router lets staff
// set up / pause / cancel / manually fire them.
//
// Endpoints:
//   GET    /api/staff/engagement-recurrences
//   POST   /api/staff/engagement-recurrences
//   PATCH  /api/staff/engagement-recurrences/:id      (pause/resume/edit)
//   DELETE /api/staff/engagement-recurrences/:id      (soft cancel)
//   POST   /api/staff/engagement-recurrences/:id/run-now
//
// All gated by engagement:write. Cross-firm guard on every read +
// write via the firm_id column.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { aliasedTable, and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagementRecurrences, engagementTemplates, engagements } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';
import { spawnNextEngagement } from './recurrence-spawn';

export interface EngagementRecurrenceRoutesDeps extends RbacDeps {
  db: Database | null;
}

const FREQUENCIES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const;
// Lifecycle status the spawned engagement gets. NULL inherits the template's
// default_recurrence_status, which itself falls back to 'ACTIVE' at spawn.
const SPAWN_STATUSES = ['PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED'] as const;

const CreateSchema = z
  .object({
    clientId: z.string().uuid(),
    templateId: z.string().uuid(),
    frequency: z.enum(FREQUENCIES),
    triggerMode: z.enum(['SCHEDULE', 'ON_COMPLETION']),
    nextRunDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    seedPeriodYear: z.number().int().min(1900).max(9999).optional(),
    seedPeriodMonth: z.number().int().min(1).max(12).optional(),
    seedPeriodLabel: z.string().max(80).optional(),
    spawnStatus: z.enum(SPAWN_STATUSES).optional(),
    rollforwardAppointment: z.boolean().optional(),
    rollforwardDropoff: z.boolean().optional(),
    notes: z.string().max(2000).optional(),
    // Optional back-pointer so the first spawn advances from an existing
    // engagement's period (used when adding a recurrence from a detail page).
    lastEngagementId: z.string().uuid().optional(),
  })
  .refine((v) => (v.triggerMode === 'SCHEDULE' ? !!v.nextRunDate : true), {
    message: 'nextRunDate is required when triggerMode=SCHEDULE',
    path: ['nextRunDate'],
  });

const PatchSchema = z
  .object({
    frequency: z.enum(FREQUENCIES).optional(),
    triggerMode: z.enum(['SCHEDULE', 'ON_COMPLETION']).optional(),
    nextRunDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    seedPeriodYear: z.number().int().min(1900).max(9999).nullable().optional(),
    seedPeriodMonth: z.number().int().min(1).max(12).nullable().optional(),
    seedPeriodLabel: z.string().max(80).nullable().optional(),
    status: z.enum(['ACTIVE', 'PAUSED']).optional(),
    spawnStatus: z.enum(SPAWN_STATUSES).nullable().optional(),
    rollforwardAppointment: z.boolean().optional(),
    rollforwardDropoff: z.boolean().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'no_fields_to_update' });

export function createEngagementRecurrenceRouter(deps: EngagementRecurrenceRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // List — firm-scoped, joins client + template + last engagement for
  // a single-shot table render. Optional filters:
  //   ?clientId=…  scope to one client (client-detail card)
  //   ?dueOnly=true  only return recurrences ready to fire now
  //                  (SCHEDULE && nextRunDate<=today, OR
  //                   ON_COMPLETION && last engagement is null/CLOSED).
  //                  Used by the firm-wide bulk dialog.
  router.get(
    '/',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const clientFilter = uuidQueryParam(req.query['clientId']);
      if (clientFilter === 'invalid') {
        res.status(400).json({ error: 'invalid_client_id' });
        return;
      }
      const dueOnly = req.query['dueOnly'] === 'true';

      const lastEng = aliasedTable(engagements, 'last_eng');
      const conds = [eq(engagementRecurrences.firmId, session.firmId)];
      if (clientFilter) conds.push(eq(engagementRecurrences.clientId, clientFilter));

      const rows = await deps.db
        .select({
          id: engagementRecurrences.id,
          clientId: engagementRecurrences.clientId,
          clientName: clients.name,
          templateId: engagementRecurrences.templateId,
          templateName: engagementTemplates.name,
          templateNamePattern: engagementTemplates.namePattern,
          frequency: engagementRecurrences.frequency,
          triggerMode: engagementRecurrences.triggerMode,
          nextRunDate: engagementRecurrences.nextRunDate,
          seedPeriodYear: engagementRecurrences.seedPeriodYear,
          seedPeriodMonth: engagementRecurrences.seedPeriodMonth,
          seedPeriodLabel: engagementRecurrences.seedPeriodLabel,
          lastEngagementId: engagementRecurrences.lastEngagementId,
          lastEngagementName: lastEng.name,
          lastEngagementStatus: lastEng.status,
          lastRunAt: engagementRecurrences.lastRunAt,
          status: engagementRecurrences.status,
          spawnStatus: engagementRecurrences.spawnStatus,
          rollforwardAppointment: engagementRecurrences.rollforwardAppointment,
          rollforwardDropoff: engagementRecurrences.rollforwardDropoff,
          notes: engagementRecurrences.notes,
          createdAt: engagementRecurrences.createdAt,
        })
        .from(engagementRecurrences)
        .innerJoin(clients, eq(clients.id, engagementRecurrences.clientId))
        .innerJoin(
          engagementTemplates,
          eq(engagementTemplates.id, engagementRecurrences.templateId),
        )
        .leftJoin(lastEng, eq(lastEng.id, engagementRecurrences.lastEngagementId))
        .where(and(...conds))
        .orderBy(desc(engagementRecurrences.createdAt))
        .limit(500);

      const today = new Date().toISOString().slice(0, 10);
      const enriched = rows.map((r) => {
        const isScheduleDue =
          r.status === 'ACTIVE' &&
          r.triggerMode === 'SCHEDULE' &&
          r.nextRunDate != null &&
          (typeof r.nextRunDate === 'string' ? r.nextRunDate : String(r.nextRunDate)) <= today;
        const isCompletionDue =
          r.status === 'ACTIVE' &&
          r.triggerMode === 'ON_COMPLETION' &&
          (r.lastEngagementId == null || r.lastEngagementStatus === 'CLOSED');
        const isDue = isScheduleDue || isCompletionDue;
        return { ...r, isDue };
      });
      const items = dueOnly ? enriched.filter((r) => r.isDue) : enriched;
      res.json({ items });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      // Cross-firm guard: client + template must belong to the firm.
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const [tpl] = await deps.db
        .select({ id: engagementTemplates.id })
        .from(engagementTemplates)
        .where(
          and(
            eq(engagementTemplates.id, parsed.data.templateId),
            eq(engagementTemplates.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!tpl) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }
      // Validate the optional last-engagement back-pointer belongs to this
      // firm + client; ignore silently if it doesn't.
      let resolvedLastEngagementId: string | null = null;
      if (parsed.data.lastEngagementId) {
        // The client is already firm-verified above, so matching clientId
        // firm-scopes this lookup.
        const [eng] = await deps.db
          .select({ id: engagements.id })
          .from(engagements)
          .where(
            and(
              eq(engagements.id, parsed.data.lastEngagementId),
              eq(engagements.clientId, parsed.data.clientId),
            ),
          )
          .limit(1);
        if (eng) resolvedLastEngagementId = eng.id;
      }
      const [row] = await deps.db
        .insert(engagementRecurrences)
        .values({
          firmId: session.firmId,
          clientId: parsed.data.clientId,
          templateId: parsed.data.templateId,
          frequency: parsed.data.frequency,
          triggerMode: parsed.data.triggerMode,
          nextRunDate: parsed.data.nextRunDate ?? null,
          seedPeriodYear: parsed.data.seedPeriodYear ?? null,
          seedPeriodMonth: parsed.data.seedPeriodMonth ?? null,
          seedPeriodLabel: parsed.data.seedPeriodLabel ?? null,
          spawnStatus: parsed.data.spawnStatus ?? null,
          rollforwardAppointment: parsed.data.rollforwardAppointment ?? false,
          rollforwardDropoff: parsed.data.rollforwardDropoff ?? false,
          notes: parsed.data.notes ?? null,
          lastEngagementId: resolvedLastEngagementId,
          createdById: session.appUserId,
        })
        .returning({ id: engagementRecurrences.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_recurrence',
        entityId: row?.id ?? null,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.warn({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const [existing] = await deps.db
        .select()
        .from(engagementRecurrences)
        .where(
          and(
            eq(engagementRecurrences.id, req.params['id']!),
            eq(engagementRecurrences.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Honor the schema CHECK: SCHEDULE requires nextRunDate.
      const newTriggerMode = parsed.data.triggerMode ?? existing.triggerMode;
      const newNextRunDate =
        parsed.data.nextRunDate !== undefined ? parsed.data.nextRunDate : existing.nextRunDate;
      if (newTriggerMode === 'SCHEDULE' && newNextRunDate == null) {
        res.status(400).json({ error: 'next_run_date_required_for_schedule' });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.frequency !== undefined) patch['frequency'] = parsed.data.frequency;
      if (parsed.data.triggerMode !== undefined) patch['triggerMode'] = parsed.data.triggerMode;
      if (parsed.data.nextRunDate !== undefined) patch['nextRunDate'] = parsed.data.nextRunDate;
      if (parsed.data.seedPeriodYear !== undefined)
        patch['seedPeriodYear'] = parsed.data.seedPeriodYear;
      if (parsed.data.seedPeriodMonth !== undefined)
        patch['seedPeriodMonth'] = parsed.data.seedPeriodMonth;
      if (parsed.data.seedPeriodLabel !== undefined)
        patch['seedPeriodLabel'] = parsed.data.seedPeriodLabel;
      if (parsed.data.status !== undefined) patch['status'] = parsed.data.status;
      if (parsed.data.spawnStatus !== undefined) patch['spawnStatus'] = parsed.data.spawnStatus;
      if (parsed.data.rollforwardAppointment !== undefined)
        patch['rollforwardAppointment'] = parsed.data.rollforwardAppointment;
      if (parsed.data.rollforwardDropoff !== undefined)
        patch['rollforwardDropoff'] = parsed.data.rollforwardDropoff;
      if (parsed.data.notes !== undefined) patch['notes'] = parsed.data.notes;
      // When trigger flips to ON_COMPLETION, drop the date so the
      // schema CHECK (schedule = has-date) is satisfied.
      if (parsed.data.triggerMode === 'ON_COMPLETION') {
        patch['nextRunDate'] = null;
      }
      await deps.db
        .update(engagementRecurrences)
        .set(patch)
        .where(eq(engagementRecurrences.id, existing.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_recurrence',
        entityId: existing.id,
        actorAppUserId: session.appUserId,
        before: existing,
        after: parsed.data,
        ip: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.warn({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // Soft cancel — sets status='CANCELLED'. Keeps the row for audit
  // history; can be re-activated via PATCH.
  router.delete(
    '/:id',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [existing] = await deps.db
        .select({ id: engagementRecurrences.id })
        .from(engagementRecurrences)
        .where(
          and(
            eq(engagementRecurrences.id, req.params['id']!),
            eq(engagementRecurrences.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(engagementRecurrences)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(eq(engagementRecurrences.id, existing.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'engagement_recurrence',
        entityId: existing.id,
        actorAppUserId: session.appUserId,
      }).catch((err: unknown) => logger.warn({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/run-now',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const result = await spawnNextEngagement({
        db: deps.db,
        recurrenceId: req.params['id']!,
        firmId: session.firmId,
        actorAppUserId: session.appUserId,
      });
      if (result.kind === 'skipped' && result.reason === 'not_found') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (result.kind === 'skipped' && result.reason === 'cross_firm') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (result.kind === 'error') {
        res.status(500).json({ error: result.reason });
        return;
      }
      res.json(result);
    },
  );

  // Bulk run-now. Accepts an array of recurrence ids; calls
  // spawnNextEngagement on each and returns per-id outcomes so the
  // caller can render a result summary (spawned / approval queued /
  // skipped / error).
  router.post(
    '/bulk-run',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const Schema = z.object({
        recurrenceIds: z.array(z.string().uuid()).min(1).max(200),
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const results: Array<{
        recurrenceId: string;
        kind: string;
        engagementId?: string;
        approvalRequestId?: string;
        name?: string;
        reason?: string;
      }> = [];
      for (const id of parsed.data.recurrenceIds) {
        const out = await spawnNextEngagement({
          db: deps.db,
          recurrenceId: id,
          firmId: session.firmId,
          actorAppUserId: session.appUserId,
        });
        results.push({ recurrenceId: id, ...out });
      }
      const summary = results.reduce<Record<string, number>>((acc, r) => {
        acc[r.kind] = (acc[r.kind] ?? 0) + 1;
        return acc;
      }, {});
      res.json({ results, summary });
    },
  );

  // Suppress unused-import lint when only a subset of joins is reached.
  void engagements;
  return router;
}
