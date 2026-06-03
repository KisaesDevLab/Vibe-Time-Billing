// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Engagement management (Phase 8).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, or, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clients,
  engagementAssignments,
  engagementNotes,
  engagementTemplates,
  engagementTypes,
  engagements,
  firmSettings,
  hourBanks,
  milestonePlans,
  milestones,
  serviceLines,
  timeEntries,
} from '@vibe/db/schema';
import { resolveEngagementName, type Period } from '@vibe/core/engagements';
import { desc } from 'drizzle-orm';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';
import {
  archiveThreadForEngagement,
  provisionThreadForEngagement,
} from '../engagement-messaging/lifecycle';
import { getApplianceLockState } from '../crypto/boot';

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

function csv(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface EngagementRoutesDeps extends RbacDeps {
  db: Database | null;
}

const EngagementCreateSchema = z.object({
  clientId: z.string().uuid(),
  // Name is optional when templateId is sent AND that template has a
  // name_pattern — the server resolves the pattern using `period` +
  // client + today. Handler enforces "must have either explicit name
  // or template+pattern that resolves to non-empty" with a 400.
  name: z.string().min(1).max(200).optional(),
  // 0083 — when set, server loads the template, copies any non-
  // overridden defaults, and (if no explicit name) resolves
  // template.name_pattern via resolveEngagementName.
  templateId: z.string().uuid().optional(),
  // 0083 — period inputs persisted on the new engagement +
  // substituted into the template name_pattern.
  period: z
    .object({
      year: z.number().int().min(1900).max(9999).nullable().optional(),
      month: z.number().int().min(1).max(12).nullable().optional(),
      label: z.string().max(80).nullable().optional(),
    })
    .optional(),
  // Nullable so PATCH callers can clear the type (set NULL) by sending
  // `null`. POST callers still treat it as a normal optional uuid.
  engagementTypeId: z.string().uuid().nullable().optional(),
  feeStructure: z.enum([
    'HOURLY',
    'HOURLY_NTE',
    'FIXED_FEE',
    'FIXED_FEE_WITH_MILESTONES',
    'RECURRING_SUBSCRIPTION',
  ]),
  feeAmountCents: z.number().int().nonnegative().optional(),
  budgetHours: z.number().nonnegative().optional(),
  budgetAmountCents: z.number().int().nonnegative().optional(),
  mixedModeEnabled: z.boolean().optional(),
  inScopeWorkCodeIds: z.array(z.string().uuid()).max(200).optional(),
  nteCapCents: z.number().int().nonnegative().optional(),
  nteCapScope: z.enum(['PERIOD', 'LIFETIME']).optional(),
  feePassthroughEnabled: z.boolean().optional(),
  // v2 — sales tax (per-engagement). Rate in basis points 0..10000.
  taxEnabled: z.boolean().optional(),
  taxRateBps: z.number().int().min(0).max(10_000).optional(),
  taxLabel: z.string().min(1).max(80).optional(),
  // v2 — per-engagement surcharge. Type discriminator picks which
  // value field is read at invoice-generation time.
  surchargeEnabled: z.boolean().optional(),
  surchargeType: z.enum(['PERCENT', 'FLAT_AMOUNT']).optional(),
  surchargeValueBps: z.number().int().min(0).max(10_000).optional(),
  surchargeAmountCents: z.number().int().nonnegative().optional(),
  surchargeLabel: z.string().min(1).max(80).nullable().optional(),
  partnerId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  scopeDefinition: z.string().max(10_000).optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  // 0051 — external deadline.
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  autoRolloverEnabled: z.boolean().optional(),
  // Phase 7 #13 — premium/discount multiplier in basis points (10000 = 1.0x).
  rateMultiplierBps: z.number().int().min(1000).max(50000).optional(),
  // 0054 — drives staff_rate_snapshot lookup. NULL = StandardRate fallback.
  defaultRateCodeId: z.string().uuid().nullable().optional(),
  // Optional hour-bank attachment. When supplied, the engagement is
  // created and an hour_bank row is inserted in the same transaction.
  // Phase 8 #8 — bank-bearing engagements no longer need a second POST.
  hourBank: z
    .object({
      openingHours: z.number().positive().max(10_000),
      openingAmountCents: z.number().int().nonnegative(),
      rolloverCapHours: z.number().nonnegative().max(10_000).optional(),
      expirationDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .optional(),
  // 0050 — staff assignments at create time (in addition to or instead
  // of partnerId/managerId). Inserted into engagement_assignment.
  assignments: z
    .array(
      z.object({
        appUserId: z.string().uuid(),
        role: z.enum(['PARTNER', 'MANAGER', 'REVIEWER', 'PREPARER', 'STAFF']),
      }),
    )
    .max(50)
    .optional(),
});

const EngagementStatusSchema = z.object({
  status: z.enum(['PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED']),
  reason: z.string().max(400).optional(),
});

async function clientBelongsToFirm(
  db: Database,
  firmId: string,
  clientId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  return Boolean(row);
}

export function createEngagementRouter(deps: EngagementRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get(
    '/',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      // Scope via inner join on client so we don't have to pre-fetch
      // firm clients separately for big firms.
      const conds = [eq(clients.firmId, firmId)];

      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      const allowed = ['PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED'];
      if (status && allowed.includes(status)) {
        conds.push(
          eq(
            engagements.status,
            status as 'PROPOSED' | 'ACTIVE' | 'PAUSED' | 'CLOSED' | 'ARCHIVED',
          ),
        );
      }

      // v2 Part 2 — workflow_state filter (CSV multi-select).
      const wsRaw =
        typeof req.query['workflowState'] === 'string' ? req.query['workflowState'] : '';
      const wsAllowed = [
        'NO_STATUS',
        'NOT_STARTED',
        'READY',
        'IN_PROGRESS',
        'ON_HOLD',
        'NEEDS_REVIEW',
        'WITH_CLIENT',
        'COMPLETED',
        'CANCELED',
        'DRAFT',
      ] as const;
      type WorkflowState = (typeof wsAllowed)[number];
      const wsValues = wsRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is WorkflowState => (wsAllowed as readonly string[]).includes(s));
      if (wsValues.length > 0) {
        conds.push(inArray(engagements.workflowState, wsValues));
      }

      // Priority filter (CSV multi-select).
      const prRaw = typeof req.query['priority'] === 'string' ? req.query['priority'] : '';
      const prAllowed = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
      type Priority = (typeof prAllowed)[number];
      const prValues = prRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is Priority => (prAllowed as readonly string[]).includes(s));
      if (prValues.length > 0) {
        conds.push(inArray(engagements.priority, prValues));
      }

      const partnerId = typeof req.query['partnerId'] === 'string' ? req.query['partnerId'] : null;
      if (partnerId) conds.push(eq(engagements.partnerId, partnerId));
      const managerId = typeof req.query['managerId'] === 'string' ? req.query['managerId'] : null;
      if (managerId) conds.push(eq(engagements.managerId, managerId));

      // 0050 — assigneeUserId now matches partner OR manager OR a row
      // in engagement_assignment (multi-staff per engagement).
      const assigneeUserId =
        typeof req.query['assigneeUserId'] === 'string' ? req.query['assigneeUserId'] : null;
      if (assigneeUserId) {
        const orExpr = or(
          eq(engagements.partnerId, assigneeUserId),
          eq(engagements.managerId, assigneeUserId),
          sql`EXISTS (SELECT 1 FROM engagement_assignment ea WHERE ea.engagement_id = ${engagements.id} AND ea.app_user_id = ${assigneeUserId})`,
        );
        if (orExpr) conds.push(orExpr);
      }

      const clientId = uuidQueryParam(req.query['clientId']);
      if (clientId === 'invalid') {
        res.status(400).json({ error: 'invalid_client_id' });
        return;
      }
      if (clientId) conds.push(eq(engagements.clientId, clientId));

      // 0050 — filter to engagements whose client has a given owner
      // (client.partnerInChargeId). Surfaced across the UI as a chip.
      const clientOwnerId = uuidQueryParam(req.query['clientOwnerId']);
      if (clientOwnerId === 'invalid') {
        res.status(400).json({ error: 'invalid_client_owner_id' });
        return;
      }
      if (clientOwnerId) conds.push(eq(clients.partnerInChargeId, clientOwnerId));

      const feeStructure =
        typeof req.query['feeStructure'] === 'string' ? req.query['feeStructure'] : null;
      const allowedFees = [
        'HOURLY',
        'HOURLY_NTE',
        'FIXED_FEE',
        'FIXED_FEE_WITH_MILESTONES',
        'RECURRING_SUBSCRIPTION',
      ];
      if (feeStructure && allowedFees.includes(feeStructure)) {
        conds.push(
          eq(
            engagements.feeStructure,
            feeStructure as
              | 'HOURLY'
              | 'HOURLY_NTE'
              | 'FIXED_FEE'
              | 'FIXED_FEE_WITH_MILESTONES'
              | 'RECURRING_SUBSCRIPTION',
          ),
        );
      }

      // Service line filter. Two forms supported, both optional:
      //   ?serviceLineId=<uuid>           — exact service line
      //   ?serviceLineCategory=tax|...    — enum category roll-up
      // Both join through engagement_type. Engagements with no type
      // are excluded by either filter.
      const serviceLineId = uuidQueryParam(req.query['serviceLineId']);
      if (serviceLineId === 'invalid') {
        res.status(400).json({ error: 'invalid_service_line_id' });
        return;
      }
      if (serviceLineId) {
        conds.push(eq(engagementTypes.serviceLineId, serviceLineId));
      }
      const slCategoryRaw =
        typeof req.query['serviceLineCategory'] === 'string'
          ? req.query['serviceLineCategory']
          : null;
      const slCategoryAllowed = ['tax', 'audit', 'advisory', 'bookkeeping', 'payroll'] as const;
      type ServiceLineCategory = (typeof slCategoryAllowed)[number];
      if (slCategoryRaw && (slCategoryAllowed as readonly string[]).includes(slCategoryRaw)) {
        conds.push(eq(serviceLines.category, slCategoryRaw as ServiceLineCategory));
      }

      // Per-engagement unbilled time-entry count. Drives the "Bill"
      // CTA on ClientDetail → Engagements: only show the button when
      // there's actually something to bill (entries where
      // billing_batch_id IS NULL AND status <> 'ARCHIVED'). Correlated
      // subquery keeps the list query a single round-trip.
      const unbilledExpr = sql<number>`(
        SELECT COUNT(*)::int
        FROM ${timeEntries}
        WHERE ${timeEntries.engagementId} = ${engagements.id}
          AND ${timeEntries.billingBatchId} IS NULL
          AND ${timeEntries.status} <> 'ARCHIVED'
      )`.as('unbilled_entry_count');

      const items = await deps.db
        .select({
          id: engagements.id,
          clientId: engagements.clientId,
          name: engagements.name,
          status: engagements.status,
          workflowState: engagements.workflowState,
          priority: engagements.priority,
          feeStructure: engagements.feeStructure,
          feeAmountCents: engagements.feeAmountCents,
          budgetHours: engagements.budgetHours,
          partnerId: engagements.partnerId,
          managerId: engagements.managerId,
          startDate: engagements.startDate,
          endDate: engagements.endDate,
          dueDate: engagements.dueDate,
          engagementTypeId: engagements.engagementTypeId,
          createdAt: engagements.createdAt,
          // Joined fields so the UI doesn't need separate lookups.
          clientName: clients.name,
          // Service-line dimension — left-joined via engagement_type so
          // engagements without a type still return (NULL service line).
          serviceLineId: serviceLines.id,
          serviceLineName: serviceLines.name,
          serviceLineCategory: serviceLines.category,
          unbilledEntryCount: unbilledExpr,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .leftJoin(engagementTypes, eq(engagementTypes.id, engagements.engagementTypeId))
        .leftJoin(serviceLines, eq(serviceLines.id, engagementTypes.serviceLineId))
        .where(and(...conds))
        .limit(500);

      // CSV export — same shape, sent as text/csv.
      if (req.query['format'] === 'csv') {
        const header = [
          'id',
          'name',
          'client',
          'service_line',
          'service_line_category',
          'status',
          'workflow_state',
          'priority',
          'fee_structure',
          'fee_amount_cents',
          'budget_hours',
          'start_date',
          'end_date',
          'due_date',
        ];
        const lines = [header.join(',')];
        const cell = (s: string | number | null | undefined): string => {
          if (s == null) return '';
          const str = String(s);
          return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
        };
        for (const it of items) {
          lines.push(
            [
              cell(it.id),
              cell(it.name),
              cell(it.clientName),
              cell(it.serviceLineName),
              cell(it.serviceLineCategory),
              cell(it.status),
              cell(it.workflowState),
              cell(it.priority),
              cell(it.feeStructure),
              cell(it.feeAmountCents),
              cell(it.budgetHours),
              cell(it.startDate),
              cell(it.endDate),
              cell(it.dueDate),
            ].join(','),
          );
        }
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="engagements-${new Date().toISOString().slice(0, 10)}.csv"`,
        );
        res.send(lines.join('\n') + '\n');
        return;
      }

      res.json({ items });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const parsed = EngagementCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, parsed.data.clientId))) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      // Phase 20 #4 — refuse fee structures the firm has disabled.
      const [fs] = await deps.db
        .select({ enabled: firmSettings.enabledFeeStructures })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, firmId))
        .limit(1);
      const enabled = fs?.enabled ?? [
        'HOURLY',
        'HOURLY_NTE',
        'FIXED_FEE',
        'FIXED_FEE_WITH_MILESTONES',
        'RECURRING_SUBSCRIPTION',
      ];
      if (!enabled.includes(parsed.data.feeStructure)) {
        res.status(409).json({
          error: 'fee_structure_disabled',
          feeStructure: parsed.data.feeStructure,
          enabled,
        });
        return;
      }
      const session = req.staffSession!;

      // 0083 — template + period resolution. Loads the template
      // (cross-firm guard), then either uses the explicit `name` or
      // resolves the template's `name_pattern` against client + period
      // + today. Period fields are persisted on the engagement row
      // regardless of whether the template uses them.
      let resolvedName = parsed.data.name?.trim() ?? '';
      if (parsed.data.templateId) {
        const [tpl] = await deps.db
          .select({
            id: engagementTemplates.id,
            name: engagementTemplates.name,
            namePattern: engagementTemplates.namePattern,
          })
          .from(engagementTemplates)
          .where(
            and(
              eq(engagementTemplates.id, parsed.data.templateId),
              eq(engagementTemplates.firmId, firmId),
            ),
          )
          .limit(1);
        if (!tpl) {
          res.status(404).json({ error: 'template_not_found' });
          return;
        }
        if (resolvedName.length === 0 && tpl.namePattern) {
          const [clientRow] = await deps.db
            .select({ name: clients.name })
            .from(clients)
            .where(eq(clients.id, parsed.data.clientId))
            .limit(1);
          const period: Period = {
            year: parsed.data.period?.year ?? null,
            month: parsed.data.period?.month ?? null,
            label: parsed.data.period?.label ?? null,
          };
          const r = resolveEngagementName(tpl.namePattern, {
            client: { name: clientRow?.name ?? null },
            period,
            today: new Date().toISOString().slice(0, 10),
          });
          resolvedName = r.output.trim();
        }
        // Fall back to the template's static name when neither path
        // produced something.
        if (resolvedName.length === 0) {
          resolvedName = tpl.name;
        }
      }
      if (resolvedName.length === 0) {
        res.status(400).json({ error: 'name_required' });
        return;
      }

      const { hourBank, assignments, templateId, period, ...engagementFields } = parsed.data;
      // templateId + period are stripped from engagementFields here so
      // they don't bleed into the engagements insert; period is mapped
      // to the explicit period_year/month/label columns below.
      void templateId;
      const insertVals = {
        ...engagementFields,
        name: resolvedName,
        budgetHours: engagementFields.budgetHours?.toString(),
        periodYear: period?.year ?? null,
        periodMonth: period?.month ?? null,
        periodLabel: period?.label ?? null,
      };
      const { engagementId, hourBankId } = await deps.db.transaction(async (tx) => {
        const [eng] = await tx
          .insert(engagements)
          .values(insertVals)
          .returning({ id: engagements.id });
        let bankId: string | null = null;
        if (hourBank && eng?.id) {
          const [bank] = await tx
            .insert(hourBanks)
            .values({
              engagementId: eng.id,
              openingHours: hourBank.openingHours.toString(),
              openingAmountCents: hourBank.openingAmountCents,
              rolloverCapHours: hourBank.rolloverCapHours?.toString() ?? null,
              expirationDate: hourBank.expirationDate ?? null,
            })
            .returning({ id: hourBanks.id });
          bankId = bank?.id ?? null;
        }
        if (assignments && assignments.length > 0 && eng?.id) {
          const rows = assignments.map((a) => ({
            engagementId: eng.id,
            appUserId: a.appUserId,
            role: a.role,
            assignedById: session.appUserId,
          }));
          // onConflictDoNothing — the (engagement,user,role) unique
          // index makes duplicates a no-op rather than an error.
          await tx.insert(engagementAssignments).values(rows).onConflictDoNothing();
        }
        return { engagementId: eng?.id, hourBankId: bankId };
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement',
        entityId: engagementId,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      if (hourBankId) {
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'hour_bank',
          entityId: hourBankId,
          actorAppUserId: session.appUserId,
          after: { engagementId, ...hourBank },
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      }
      // Stage 2 — auto-provision a messaging thread for this engagement.
      // Best-effort: if the appliance is locked we skip silently and a
      // future engagement-edit can re-trigger via syncMembers. Failures
      // are logged but don't fail the engagement create.
      if (engagementId && getApplianceLockState().kind === 'unlocked') {
        try {
          const threadId = await provisionThreadForEngagement(deps.db, {
            firmId,
            engagementId,
            title: parsed.data.name,
            creatorAppUserId: session.appUserId,
          });
          if (threadId) {
            await emitAudit(deps.db, {
              action: 'CREATE',
              entityType: 'thread',
              entityId: threadId,
              actorAppUserId: session.appUserId,
              after: { engagementId, title: parsed.data.name },
              ip: clientIp(req),
              userAgent: req.header('user-agent') ?? null,
            }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
          }
        } catch (err) {
          logger.error({ err, engagementId }, 'thread provision failed (engagement create)');
        }
      }
      res.status(201).json({ id: engagementId, hourBankId });
    },
  );

  router.get(
    '/:id',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ engagement: null });
        return;
      }
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const [client] = await deps.db
        .select({
          id: clients.id,
          name: clients.name,
          partnerInChargeId: clients.partnerInChargeId,
        })
        .from(clients)
        .where(eq(clients.id, eng.clientId))
        .limit(1);
      // 0050 — join assignments with app_user names for the detail UI.
      const assignments = await deps.db
        .select({
          id: engagementAssignments.id,
          appUserId: engagementAssignments.appUserId,
          role: engagementAssignments.role,
          assignedAt: engagementAssignments.assignedAt,
          fullName: appUsers.fullName,
          email: appUsers.email,
        })
        .from(engagementAssignments)
        .innerJoin(appUsers, eq(appUsers.id, engagementAssignments.appUserId))
        .where(eq(engagementAssignments.engagementId, eng.id))
        .orderBy(engagementAssignments.assignedAt);
      res.json({ engagement: eng, client, assignments });
    },
  );

  router.post(
    '/bulk-status',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const body = req.body as { ids?: unknown; status?: unknown; reason?: unknown };
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((x): x is string => typeof x === 'string')
        : [];
      const targetStatus = typeof body.status === 'string' ? body.status : '';
      const allowed = ['PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED'] as const;
      if (!ids.length || !(allowed as readonly string[]).includes(targetStatus)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.json({ ok: true, updated: 0 });
        return;
      }
      const reason = typeof body.reason === 'string' ? body.reason : null;
      // Scope: only update engagements whose client belongs to firm.
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, firmId));
      const clientIds = firmClients.map((c) => c.id);
      const patch: Record<string, unknown> = { status: targetStatus };
      if (targetStatus === 'CLOSED' || targetStatus === 'ARCHIVED') {
        patch['closedAt'] = new Date();
        patch['closedReason'] = reason;
      }
      const updated = await deps.db
        .update(engagements)
        .set(patch)
        .where(and(inArray(engagements.id, ids), inArray(engagements.clientId, clientIds)))
        .returning({ id: engagements.id });
      // Stage 2 — archive associated threads when engagements close or
      // archive. Best-effort; failures don't fail the status change.
      if (
        (targetStatus === 'ARCHIVED' || targetStatus === 'CLOSED') &&
        getApplianceLockState().kind === 'unlocked'
      ) {
        for (const u of updated) {
          try {
            await archiveThreadForEngagement(deps.db, u.id);
          } catch (err) {
            logger.error({ err, engagementId: u.id }, 'thread archive failed');
          }
        }
      }
      res.json({ ok: true, updated: updated.length });
    },
  );

  router.post(
    '/:id/transfer',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const toClientId = typeof req.body?.toClientId === 'string' ? req.body.toClientId : null;
      if (!toClientId) {
        res.status(400).json({ error: 'to_client_id_required' });
        return;
      }
      const [eng] = await deps.db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng || !(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, toClientId))) {
        res.status(404).json({ error: 'target_client_not_found' });
        return;
      }
      await deps.db
        .update(engagements)
        .set({ clientId: toClientId })
        .where(eq(engagements.id, req.params['id']!));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { kind: 'transfer', fromClientId: eng.clientId, toClientId },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id/budget',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [eng] = await deps.db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng || !(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const body = req.body as {
        budgetHours?: unknown;
        budgetAmountCents?: unknown;
        nteCapCents?: unknown;
      };
      const patch: Record<string, unknown> = {};
      if (typeof body.budgetHours === 'number' && body.budgetHours >= 0) {
        patch['budgetHours'] = body.budgetHours.toString();
      }
      if (typeof body.budgetAmountCents === 'number' && body.budgetAmountCents >= 0) {
        patch['budgetAmountCents'] = body.budgetAmountCents;
      }
      if (typeof body.nteCapCents === 'number' && body.nteCapCents >= 0) {
        patch['nteCapCents'] = body.nteCapCents;
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db.update(engagements).set(patch).where(eq(engagements.id, req.params['id']!));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { kind: 'budget_update', ...patch },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.get(
    '/:id/budget',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ budget: null });
        return;
      }
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const [tot] = await deps.db
        .select({
          hours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`.as('hours'),
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as(
            'amountCents',
          ),
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.engagementId, eng.id),
            inArray(timeEntries.status, ['SUBMITTED', 'LOCKED', 'BILLED']),
          ),
        );
      const actualHours = Number(tot?.hours ?? 0);
      const actualAmountCents = Number(tot?.amountCents ?? 0);
      const budgetHours = eng.budgetHours != null ? Number(eng.budgetHours) : null;
      const budgetAmountCents =
        eng.budgetAmountCents != null ? Number(eng.budgetAmountCents) : null;
      res.json({
        budget: {
          engagementId: eng.id,
          budgetHours,
          budgetAmountCents,
          nteCapCents: eng.nteCapCents != null ? Number(eng.nteCapCents) : null,
          actualHours,
          actualAmountCents,
          hoursUtilizationPct:
            budgetHours && budgetHours > 0 ? (actualHours / budgetHours) * 100 : null,
          amountUtilizationPct:
            budgetAmountCents && budgetAmountCents > 0
              ? (actualAmountCents / budgetAmountCents) * 100
              : null,
        },
      });
    },
  );

  router.get(
    '/export.csv',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.send('id,name,status\n');
        return;
      }
      const firmClients = await deps.db
        .select({ id: clients.id, name: clients.name })
        .from(clients)
        .where(eq(clients.firmId, firmId));
      const clientNameById = new Map(firmClients.map((c) => [c.id, c.name]));
      if (clientNameById.size === 0) {
        res.send('id,name,status\n');
        return;
      }
      const items = await deps.db
        .select()
        .from(engagements)
        .where(inArray(engagements.clientId, Array.from(clientNameById.keys())))
        .limit(10000);
      const header = ['id', 'name', 'clientName', 'status', 'feeStructure', 'startDate', 'endDate'];
      const lines = [header.join(',')];
      for (const e of items) {
        lines.push(
          [
            e.id,
            csv(e.name),
            csv(clientNameById.get(e.clientId) ?? ''),
            e.status,
            e.feeStructure,
            e.startDate ?? '',
            e.endDate ?? '',
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="engagements-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(lines.join('\n') + '\n');
    },
  );

  router.post(
    '/:id/clone',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [src] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!src) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, src.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const newName =
        typeof req.body?.name === 'string' && req.body.name.trim()
          ? String(req.body.name).slice(0, 200)
          : `${src.name} (copy)`;
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        closedAt: _closedAt,
        closedReason: _closedReason,
        ...clonable
      } = src as Record<string, unknown> & { id: string };
      void _id;
      void _createdAt;
      void _updatedAt;
      void _closedAt;
      void _closedReason;
      const [row] = await deps.db
        .insert(engagements)
        .values({ ...(clonable as typeof src), name: newName, status: 'PROPOSED' })
        .returning({ id: engagements.id });
      res.status(201).json({ id: row?.id });
    },
  );

  // v2 Part 2 — operational workflow state, distinct from lifecycle
  // /status above. Inline-edit from the engagements list view + the
  // engagement detail header. Single canonical handler — duplicate at
  // the kanban-drag layer (0050) was merged here.
  router.patch(
    '/:id/workflow-state',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { workflowState?: unknown };
      const ws = typeof body.workflowState === 'string' ? body.workflowState : '';
      const allowed = [
        'NO_STATUS',
        'NOT_STARTED',
        'READY',
        'IN_PROGRESS',
        'ON_HOLD',
        'NEEDS_REVIEW',
        'WITH_CLIENT',
        'COMPLETED',
        'CANCELED',
        'DRAFT',
      ] as const;
      type WorkflowState = (typeof allowed)[number];
      if (!(allowed as readonly string[]).includes(ws)) {
        res.status(400).json({ error: 'invalid_workflow_state' });
        return;
      }
      // 0050 — scope check (engagement must belong to firm) + before/after
      // capture so the audit row is reversible.
      const [eng] = await deps.db
        .select({
          id: engagements.id,
          clientId: engagements.clientId,
          prev: engagements.workflowState,
        })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng || !(await clientBelongsToFirm(deps.db, session.firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(engagements)
        .set({ workflowState: ws as WorkflowState, updatedAt: new Date() })
        .where(eq(engagements.id, eng.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_workflow_state',
        entityId: eng.id,
        actorAppUserId: session.appUserId,
        before: { workflowState: eng.prev },
        after: { workflowState: ws },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id/priority',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { priority?: unknown };
      const pr = typeof body.priority === 'string' ? body.priority : '';
      const allowed = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
      type Priority = (typeof allowed)[number];
      if (!(allowed as readonly string[]).includes(pr)) {
        res.status(400).json({ error: 'invalid_priority' });
        return;
      }
      const session = req.staffSession!;
      await deps.db
        .update(engagements)
        .set({ priority: pr as Priority })
        .where(eq(engagements.id, req.params['id']!));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { priority: pr },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id/status',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const parsed = EngagementStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const session = req.staffSession!;
      // CLOSED transition: refuse if WIP remains (SUBMITTED time entries
      // not yet attached to a billing batch).
      if (parsed.data.status === 'CLOSED') {
        const [open] = await deps.db
          .select({ c: sql<number>`COUNT(*)`.as('c') })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.engagementId, req.params['id']!),
              eq(timeEntries.status, 'SUBMITTED'),
            ),
          );
        const openCount = Number(open?.c ?? 0);
        if (openCount > 0) {
          res.status(409).json({ error: 'unresolved_wip', submittedTimeEntries: openCount });
          return;
        }
      }
      const patch: Record<string, unknown> = { status: parsed.data.status };
      if (parsed.data.status === 'CLOSED' || parsed.data.status === 'ARCHIVED') {
        patch['closedAt'] = new Date();
        patch['closedReason'] = parsed.data.reason ?? null;
      }
      await deps.db.update(engagements).set(patch).where(eq(engagements.id, req.params['id']!));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: parsed.data.status, reason: parsed.data.reason },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      // Stage 2 — archive thread when engagement closes/archives.
      if (
        (parsed.data.status === 'CLOSED' || parsed.data.status === 'ARCHIVED') &&
        getApplianceLockState().kind === 'unlocked'
      ) {
        try {
          await archiveThreadForEngagement(deps.db, req.params['id']!);
        } catch (err) {
          logger.error({ err, engagementId: req.params['id'] }, 'thread archive failed');
        }
      }

      // Phase 10 #6/#8 — fire well-known event keys. Milestones with
      // trigger_type=EVENT and trigger_event_key matching the status
      // transition flip to TRIGGERED. Best-effort; never blocks the
      // status PATCH.
      const eventKey = `engagement.${parsed.data.status.toLowerCase()}`;
      try {
        const fired = await deps.db
          .select({ id: milestones.id })
          .from(milestones)
          .innerJoin(milestonePlans, eq(milestonePlans.id, milestones.planId))
          .where(
            and(
              eq(milestones.status, 'PENDING'),
              eq(milestones.triggerType, 'EVENT'),
              eq(milestones.triggerEventKey, eventKey),
              eq(milestonePlans.engagementId, req.params['id']!),
            ),
          );
        if (fired.length > 0) {
          await deps.db
            .update(milestones)
            .set({ status: 'TRIGGERED', triggeredAt: new Date() })
            .where(
              inArray(
                milestones.id,
                fired.map((m) => m.id),
              ),
            );
          logger.info(
            { eventKey, engagementId: req.params['id'], fired: fired.length },
            'milestone event trigger fired on status PATCH',
          );
        }
      } catch (err) {
        logger.warn({ err }, 'event-trigger evaluation failed');
      }

      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const parsed = EngagementCreateSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const [eng] = await deps.db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      // Pluck non-column keys out of the spread so update() only sees
      // engagement-table columns. (assignments + hourBank live on
      // sibling tables and are handled at create-time only.)
      const { assignments: _assignments, hourBank: _hourBank, ...colsOnly } = parsed.data;
      const patch: Record<string, unknown> = { ...colsOnly };
      if (parsed.data.budgetHours != null) {
        patch['budgetHours'] = parsed.data.budgetHours.toString();
      }
      await deps.db.update(engagements).set(patch).where(eq(engagements.id, req.params['id']!));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.get(
    '/:id/notes',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [eng] = await deps.db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const items = await deps.db
        .select()
        .from(engagementNotes)
        .where(eq(engagementNotes.engagementId, req.params['id']!))
        .orderBy(desc(engagementNotes.pinned), desc(engagementNotes.createdAt))
        .limit(200);
      res.json({ items });
    },
  );

  router.delete(
    '/:id/notes/:noteId',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .delete(engagementNotes)
        .where(
          and(
            eq(engagementNotes.id, req.params['noteId']!),
            eq(engagementNotes.engagementId, req.params['id']!),
          ),
        );
      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id/notes/:noteId/pin',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const pinned = req.body?.pinned === true;
      await deps.db
        .update(engagementNotes)
        .set({ pinned })
        .where(
          and(
            eq(engagementNotes.id, req.params['noteId']!),
            eq(engagementNotes.engagementId, req.params['id']!),
          ),
        );
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/notes',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const body = typeof req.body?.body === 'string' ? req.body.body.slice(0, 8000) : null;
      if (!body) {
        res.status(400).json({ error: 'body_required' });
        return;
      }
      const pinned = req.body?.pinned === true;
      const [eng] = await deps.db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng || !(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(engagementNotes)
        .values({
          engagementId: req.params['id']!,
          authorId: session.appUserId,
          body,
          pinned,
        })
        .returning({ id: engagementNotes.id });
      res.status(201).json({ id: row?.id });
    },
  );

  // -----------------------------------------------------------------
  // Bulk reassign: change partner + manager on many engagements at once.
  // -----------------------------------------------------------------
  router.post(
    '/bulk-assign',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ updated: 0 });
        return;
      }
      const body = req.body as {
        engagementIds?: unknown;
        partnerId?: unknown;
        managerId?: unknown;
      };
      const ids = Array.isArray(body.engagementIds)
        ? body.engagementIds.filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: 'engagementIds_required' });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (typeof body.partnerId === 'string') patch['partnerId'] = body.partnerId;
      if (typeof body.managerId === 'string') patch['managerId'] = body.managerId;
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      // Scope-check via client→firm join.
      const scoped = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(clients.firmId, firmId), inArray(engagements.id, ids)));
      const allowed = scoped.map((s) => s.id);
      const updated = allowed.length
        ? await deps.db
            .update(engagements)
            .set(patch)
            .where(inArray(engagements.id, allowed))
            .returning({ id: engagements.id })
        : [];
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_bulk',
        actorAppUserId: session.appUserId,
        after: { kind: 'bulk_assign', count: updated.length, patch },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ updated: updated.length });
    },
  );

  // -----------------------------------------------------------------
  // Custom fields PATCH. Replaces the entire customFields jsonb blob.
  // -----------------------------------------------------------------
  router.patch(
    '/:id/custom-fields',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { customFields?: unknown };
      if (!body.customFields || typeof body.customFields !== 'object') {
        res.status(400).json({ error: 'customFields_required' });
        return;
      }
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      await deps.db
        .update(engagements)
        .set({ customFields: body.customFields as Record<string, unknown> })
        .where(eq(engagements.id, eng.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: eng.id,
        actorAppUserId: session.appUserId,
        after: { kind: 'custom_fields', customFields: body.customFields },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // -----------------------------------------------------------------
  // Engagement rollover-now (Phase 8 #22 v2 — partner-driven). Creates
  // a new engagement in PROPOSED status, optionally with the autoRollover
  // price-increase applied, and queues the old one to be CLOSED.
  // -----------------------------------------------------------------
  router.post(
    '/:id/rollover',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const pct = eng.autoRolloverPriceIncreasePct ? Number(eng.autoRolloverPriceIncreasePct) : 0;
      const newFee =
        eng.feeAmountCents != null
          ? Math.round(Number(eng.feeAmountCents) * (1 + pct / 100))
          : null;
      const [created] = await deps.db
        .insert(engagements)
        .values({
          clientId: eng.clientId,
          engagementTypeId: eng.engagementTypeId,
          name: `${eng.name} (rollover)`,
          feeStructure: eng.feeStructure,
          feeAmountCents: newFee,
          budgetHours: eng.budgetHours,
          budgetAmountCents: eng.budgetAmountCents,
          mixedModeEnabled: eng.mixedModeEnabled,
          inScopeWorkCodeIds: eng.inScopeWorkCodeIds,
          nteCapCents: eng.nteCapCents,
          nteCapScope: eng.nteCapScope,
          feePassthroughEnabled: eng.feePassthroughEnabled,
          partnerId: eng.partnerId,
          managerId: eng.managerId,
          scopeDefinition: eng.scopeDefinition,
          status: 'PROPOSED',
          autoRolloverEnabled: eng.autoRolloverEnabled,
          autoRolloverPriceIncreasePct: eng.autoRolloverPriceIncreasePct,
        })
        .returning({ id: engagements.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement',
        entityId: created?.id,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'rollover',
          fromEngagementId: eng.id,
          priceIncreasePct: pct,
          newFeeCents: newFee,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.status(201).json({ id: created?.id, priceIncreasePct: pct });
    },
  );

  // -----------------------------------------------------------------
  // Assign-to-team (Phase 8 #10). Sets partnerId + managerId in one
  // call. Either can be null to clear.
  // -----------------------------------------------------------------
  router.post(
    '/:id/assign',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { partnerId?: unknown; managerId?: unknown };
      const partnerId =
        typeof body.partnerId === 'string'
          ? body.partnerId
          : body.partnerId === null
            ? null
            : undefined;
      const managerId =
        typeof body.managerId === 'string'
          ? body.managerId
          : body.managerId === null
            ? null
            : undefined;
      if (partnerId === undefined && managerId === undefined) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (partnerId !== undefined) patch['partnerId'] = partnerId;
      if (managerId !== undefined) patch['managerId'] = managerId;
      await deps.db.update(engagements).set(patch).where(eq(engagements.id, eng.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: eng.id,
        actorAppUserId: session.appUserId,
        before: { partnerId: eng.partnerId, managerId: eng.managerId },
        after: { kind: 'assign', ...patch },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // -----------------------------------------------------------------
  // NTE auto-suggest (Phase 10 #20). Suggests an NTE cap based on
  // the engagement's fee amount and recent realization. Caller can
  // accept by PATCH-ing the engagement with the returned value.
  // -----------------------------------------------------------------
  router.get(
    '/:id/nte-suggest',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ suggestedCapCents: 0 });
        return;
      }
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      // Two heuristics:
      //   1. If fee_amount_cents is set, suggest fee × 1.2 (20% cushion).
      //   2. Otherwise, suggest 1.25 × the trailing-90-day average month
      //      of unbilled standard amount, rounded up to the nearest $500.
      let suggested = 0;
      let basis = 'no_data';
      if (eng.feeAmountCents != null && Number(eng.feeAmountCents) > 0) {
        suggested = Math.round(Number(eng.feeAmountCents) * 1.2);
        basis = 'fee_with_20pct_cushion';
      } else {
        const { timeEntries: te } = await import('@vibe/db/schema');
        const { sql: drz } = await import('drizzle-orm');
        const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
        const [row] = await deps.db
          .select({
            amount: drz<number>`COALESCE(SUM(${te.standardAmountCents}), 0)`,
          })
          .from(te)
          .where(and(eq(te.engagementId, eng.id), drz`${te.entryDate} >= ${since}::date`));
        const monthlyAvg = Number(row?.amount ?? 0) / 3;
        if (monthlyAvg > 0) {
          suggested = Math.ceil((monthlyAvg * 1.25) / 50000) * 50000;
          basis = 'trailing_90d_avg_x1.25';
        }
      }
      res.json({
        engagementId: eng.id,
        currentCapCents: eng.nteCapCents == null ? null : Number(eng.nteCapCents),
        suggestedCapCents: suggested,
        basis,
      });
    },
  );

  // -----------------------------------------------------------------
  // Cost vs revenue per engagement. Cost is sum(hours × timekeeper.cost_rate)
  // for entries on this engagement; revenue is sum(invoice paid_cents)
  // attributed to this engagement as the primary engagement.
  // -----------------------------------------------------------------
  // Connect D.7 — realization defense PDF. Firm-only export bundling
  // every time entry + linked thread message into one PDF. The HTML
  // template stamps an INTERNAL banner so a casual mis-send is obvious.
  router.get(
    '/:id/realization-defense.pdf',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const { buildDefensePayload, renderDefenseHtml } = await import('./realization-defense');
      const payload = await buildDefensePayload({
        db: deps.db,
        engagementId: req.params['id']!,
        firmId,
      });
      if (!payload) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const html = renderDefenseHtml(payload);
      try {
        const { renderHtmlToPdf } = await import('../pdf/render');
        const pdf = await renderHtmlToPdf(html);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="realization-defense-${req.params['id']}.pdf"`,
        );
        res.send(pdf);
      } catch (err) {
        // PDF renderer not available (dev without Chrome, sidecar
        // unreachable) — serve HTML inline so the partner can still
        // pull the report. Tag the response with a header so the UI
        // knows to render-vs-download appropriately.
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Defense-Fallback', 'html');
        res.send(html);
      }
    },
  );

  router.get(
    '/:id/cost-vs-revenue',
    requirePermission(deps, 'report:profitability:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ summary: null });
        return;
      }
      const [eng] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const { invoices } = await import('@vibe/db/schema');
      // 0063 — cost is now snapshotted at write time on time_entry.
      // No more LATERAL/correlated lookup against staff_rate_snapshot;
      // backdated snapshot edits no longer shift historical cost.
      const [cost] = await deps.db
        .select({
          c: sql<number>`COALESCE(SUM(${timeEntries.hours}::numeric * COALESCE(${timeEntries.costRateSnapshotCents}, 0)), 0)::bigint`,
        })
        .from(timeEntries)
        .where(eq(timeEntries.engagementId, eng.id));
      const [rev] = await deps.db
        .select({
          billed: sql<number>`COALESCE(SUM(${invoices.totalCents}), 0)`,
          paid: sql<number>`COALESCE(SUM(${invoices.paidCents}), 0)`,
        })
        .from(invoices)
        .where(eq(invoices.primaryEngagementId, eng.id));
      const costCents = Number(cost?.c ?? 0);
      const billedCents = Number(rev?.billed ?? 0);
      const paidCents = Number(rev?.paid ?? 0);
      res.json({
        summary: {
          engagementId: eng.id,
          costCents,
          billedCents,
          paidCents,
          marginCents: paidCents - costCents,
          marginPct: paidCents > 0 ? ((paidCents - costCents) / paidCents) * 100 : null,
        },
      });
    },
  );

  // -----------------------------------------------------------------
  // Fixed-fee gap (Phase 11 #17). For FIXED_FEE and FIXED_FEE_WITH_*
  // engagements, the gap is (standard_amount_of_time_entries - fee).
  // Positive gap = unbilled work in excess of fee; negative = budget
  // headroom remaining.
  // -----------------------------------------------------------------
  router.get(
    '/:id/fixed-fee-gap',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ gapCents: 0, feeCents: 0, wipCents: 0 });
        return;
      }
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (eng.feeAmountCents == null) {
        res.status(409).json({ error: 'no_fee_set', feeStructure: eng.feeStructure });
        return;
      }
      const { timeEntries: te } = await import('@vibe/db/schema');
      const { sql: drz } = await import('drizzle-orm');
      const [wip] = await deps.db
        .select({
          amount: drz<number>`COALESCE(SUM(${te.standardAmountCents}), 0)`,
          hours: drz<string>`COALESCE(SUM(${te.hours}), 0)`,
        })
        .from(te)
        .where(and(eq(te.engagementId, eng.id), eq(te.billableFlag, true)));
      const fee = Number(eng.feeAmountCents);
      const wipCents = Number(wip?.amount ?? 0);
      res.json({
        engagementId: eng.id,
        feeStructure: eng.feeStructure,
        feeCents: fee,
        wipCents,
        wipHours: Number(wip?.hours ?? 0),
        gapCents: wipCents - fee,
      });
    },
  );

  // ------------------------------------------------------------------
  // 0050 — engagement assignments (multi-staff). partner_id / manager_id
  // stay on the engagement row for backwards-compat; this layer adds
  // additional staff with explicit roles and widens "My Work".
  // ------------------------------------------------------------------
  const AssignmentCreateSchema = z.object({
    appUserId: z.string().uuid(),
    role: z.enum(['PARTNER', 'MANAGER', 'REVIEWER', 'PREPARER', 'STAFF']),
  });

  router.post(
    '/:id/assignments',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const parsed = AssignmentCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const [eng] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng || !(await clientBelongsToFirm(deps.db, session.firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Verify the target user belongs to the same firm.
      const [user] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, parsed.data.appUserId), eq(appUsers.firmId, session.firmId)))
        .limit(1);
      if (!user) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(engagementAssignments)
        .values({
          engagementId: eng.id,
          appUserId: parsed.data.appUserId,
          role: parsed.data.role,
          assignedById: session.appUserId,
        })
        .onConflictDoNothing()
        .returning({ id: engagementAssignments.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_assignment',
        entityId: row?.id ?? null,
        actorAppUserId: session.appUserId,
        after: { engagementId: eng.id, ...parsed.data },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id ?? null });
    },
  );

  router.delete(
    '/:id/assignments/:assignmentId',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [eng] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng || !(await clientBelongsToFirm(deps.db, session.firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const removed = await deps.db
        .delete(engagementAssignments)
        .where(
          and(
            eq(engagementAssignments.id, req.params['assignmentId']!),
            eq(engagementAssignments.engagementId, eng.id),
          ),
        )
        .returning({ id: engagementAssignments.id });
      if (removed.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'engagement_assignment',
        entityId: req.params['assignmentId']!,
        actorAppUserId: session.appUserId,
        after: { engagementId: eng.id },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // ------------------------------------------------------------------
  // 0050 — retainer lock toggle. When retainer_locked_at is set, time
  // entries on this engagement are refused (409 retainer_locked from
  // time-entries POST/PATCH). Lock + unlock are idempotent — second call
  // is a no-op so the UI doesn't need to read state-before-toggle.
  // ------------------------------------------------------------------
  router.post(
    '/:id/retainer/lock',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [eng] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng || !(await clientBelongsToFirm(deps.db, session.firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const lockedAt = new Date();
      await deps.db
        .update(engagements)
        .set({ retainerLockedAt: lockedAt, updatedAt: lockedAt })
        .where(eq(engagements.id, eng.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_retainer_lock',
        entityId: eng.id,
        actorAppUserId: session.appUserId,
        after: { retainerLockedAt: lockedAt.toISOString() },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, retainerLockedAt: lockedAt.toISOString() });
    },
  );

  router.post(
    '/:id/retainer/unlock',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [eng] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng || !(await clientBelongsToFirm(deps.db, session.firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(engagements)
        .set({ retainerLockedAt: null, updatedAt: new Date() })
        .where(eq(engagements.id, eng.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_retainer_lock',
        entityId: eng.id,
        actorAppUserId: session.appUserId,
        after: { retainerLockedAt: null },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}
