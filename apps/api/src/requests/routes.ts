// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Stage 3 — client request workflow. Staff create + manage; the
// portal-side endpoint (not in this router) handles client
// fulfillment. Routes:
//
//   GET    /                  list requests (filterable)
//   GET    /:id               single request
//   POST   /                  create
//   POST   /:id/fulfill       staff fulfills on client's behalf (e.g.
//                             received via email + uploaded). Inserts
//                             a suggestion link in the assigned
//                             staff's queue.
//   POST   /:id/dismiss       mark dismissed
//   POST   /:id/reopen        flip dismissed → open
//   PATCH  /:id               update title/body/due date
//
//   GET    /suggestions/mine  pending time-entry suggestions for the
//                             logged-in staff
//   POST   /suggestions/:id/accept   accept (creates time entry)
//   POST   /suggestions/:id/dismiss  dismiss

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientRequestItems,
  clientRequestTimeEntryLinks,
  clientRequests,
  clients,
  engagementAssignments,
  engagements,
  firmConfig,
  firmSettings,
  requestTemplateItems,
  requestTemplates,
  timeEntries,
} from '@vibe/db/schema';

import { spawnFromTemplate, type Priority } from './template-spawn';
import { ReminderScheduleSchema } from '../appointments/reminders-validation';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { blockIfClientRestricted, getBlockedClientIdsCached } from '../clients/access';
import { normalizeSubfolder } from '../clients/files';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface RequestRoutesDeps extends RbacDeps {
  db: Database | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const ITEM_KINDS = ['QUESTION', 'DOCUMENT', 'SIGNATURE'] as const;
// 0135 — request kind discriminator. DROP_OFF is an engagement info
// hand-off with once-only email+SMS reminders.
const REQUEST_KINDS = ['GENERAL', 'DROP_OFF'] as const;

const ItemInputSchema = z.object({
  ordinal: z.number().int().min(0).max(500),
  label: z.string().min(1).max(200),
  body: z.string().max(2000).optional(),
  itemKind: z.enum(ITEM_KINDS).default('QUESTION'),
  required: z.boolean().default(true),
  dueDate: z.string().regex(DATE_RE).nullable().optional(),
});

const CreateSchema = z.object({
  engagementId: z.string().uuid(),
  // 0084 — title is optional when templateId resolves to a non-empty pattern.
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(5000).optional().default(''),
  kind: z.enum(REQUEST_KINDS).default('GENERAL'),
  assignedAppUserId: z.string().uuid().nullable().optional(),
  dueDate: z.string().regex(DATE_RE).nullable().optional(),
  templateId: z.string().uuid().optional(),
  priority: z.enum(PRIORITIES).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  reminderDaysBefore: z.number().int().min(0).max(365).nullable().optional(),
  // 0194 — drop-off multi-reminder schedule (offsetMinutes + channel steps).
  reminderSchedule: ReminderScheduleSchema.nullable().optional(),
  // 0198 — when set, the request is created PENDING (hidden) and the worker
  // opens + submits it to the client on this date.
  activationDate: z.string().regex(DATE_RE).nullable().optional(),
  items: z.array(ItemInputSchema).max(100).optional(),
  // 0220 — destination subfolder for portal DOCUMENT-item uploads
  // ('' or absent = the client folder root).
  targetSubfolderPath: z.string().max(512).optional(),
});

const REQUEST_STATUSES = [
  'OPEN',
  'PENDING',
  'NEEDS_INFO',
  'FULFILLED',
  'DISMISSED',
  'EXPIRED',
] as const;

const PatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(5000).optional(),
  assignedAppUserId: z.string().uuid().nullable().optional(),
  dueDate: z.string().regex(DATE_RE).nullable().optional(),
  engagementId: z.string().uuid().optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(REQUEST_STATUSES).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  reminderDaysBefore: z.number().int().min(0).max(365).nullable().optional(),
});

const BulkSchema = z.object({
  templateId: z.string().uuid(),
  targets: z
    .array(
      z.object({
        clientId: z.string().uuid(),
        engagementId: z.string().uuid(),
        dueDateOverride: z.string().regex(DATE_RE).nullable().optional(),
        priorityOverride: z.enum(PRIORITIES).optional(),
        assignedAppUserIdOverride: z.string().uuid().nullable().optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
      }),
    )
    .min(1)
    .max(100),
});

const NeedsInfoSchema = z.object({ text: z.string().min(1).max(2000) });

const ItemPatchSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  body: z.string().max(2000).optional(),
  dueDate: z.string().regex(DATE_RE).nullable().optional(),
});

const ItemFulfillSchema = z.object({
  fileId: z.string().uuid().nullable().optional(),
  text: z.string().max(2000).optional(),
});

const FulfillSchema = z.object({
  reason: z.string().max(500).optional(),
  messageId: z.string().uuid().nullable().optional(),
  fileId: z.string().uuid().nullable().optional(),
});

const DismissSchema = z.object({
  reason: z.string().max(500).optional(),
});

const AcceptSuggestionSchema = z.object({
  // Caller may pass a freshly-created time_entry_id (already linked
  // by the timer UI). When absent, "accept" just marks the suggestion
  // accepted with no time entry attachment yet — the staff can hit
  // the timer separately.
  timeEntryId: z.string().uuid().nullable().optional(),
});

function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

async function getSuggestionExpirationDays(db: Database, firmId: string): Promise<number> {
  const [row] = await db
    .select({ days: firmConfig.suggestionExpirationDays })
    .from(firmConfig)
    .where(eq(firmConfig.firmId, firmId))
    .limit(1);
  return row?.days ?? 7;
}

// 0204 — when a drop-off date is entered for an engagement that has no due date
// yet, set the due date to firm_settings.dropoff_due_offset_days after the
// drop-off. No-op when the offset is unset (feature disabled) or the engagement
// already has a due date. Runs inside the caller's transaction.
async function applyDropoffDueDate(
  db: Database,
  firmId: string,
  engagementId: string,
  dropDate: string,
): Promise<void> {
  const [settings] = await db
    .select({ offset: firmSettings.dropoffDueOffsetDays })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  const offset = settings?.offset;
  if (offset == null) return; // feature disabled
  const [eng] = await db
    .select({ dueDate: engagements.dueDate })
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  if (!eng || eng.dueDate) return; // no engagement, or it already has a due date
  const d = new Date(`${dropDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return;
  d.setUTCDate(d.getUTCDate() + offset);
  await db
    .update(engagements)
    .set({ dueDate: d.toISOString().slice(0, 10) })
    .where(eq(engagements.id, engagementId));
}

export function createRequestRouter(deps: RequestRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // 0165 — enforce client-access restriction on every single-request route
  // (detail + all mutations: activate, needs-info, fulfill, items, delete).
  // The list endpoint filters blocked clients itself; this closes the
  // detail/mutation gap uniformly via the shared `:id` param. Runs after
  // the UUID guard (which next('route')s non-UUIDs), so `id` is a valid
  // UUID here. A request that doesn't resolve falls through to the
  // handler's own 404.
  router.param('id', (req: Request, res: Response, next: NextFunction, id: string) => {
    if (!deps.db || !req.staffSession) {
      next();
      return;
    }
    void (async () => {
      const [row] = await deps
        .db!.select({ clientId: engagements.clientId })
        .from(clientRequests)
        .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
        .where(and(eq(clientRequests.id, id), eq(clientRequests.firmId, req.staffSession!.firmId)))
        .limit(1);
      if (!row) {
        next();
        return;
      }
      if (await blockIfClientRestricted(deps, req, res, row.clientId)) return;
      next();
    })().catch(next);
  });

  router.get('/', requirePermission(deps, 'requests:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [], total: 0 });
      return;
    }
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
    const engagementIdParam = uuidQueryParam(req.query['engagementId']);
    if (engagementIdParam === 'invalid') {
      res.status(400).json({ error: 'invalid_engagement_id' });
      return;
    }
    const clientIdParam = uuidQueryParam(req.query['clientId']);
    if (clientIdParam === 'invalid') {
      res.status(400).json({ error: 'invalid_client_id' });
      return;
    }
    const assignedParam = uuidQueryParam(req.query['assignedAppUserId']);
    if (assignedParam === 'invalid') {
      res.status(400).json({ error: 'invalid_assigned_app_user_id' });
      return;
    }
    const priorityParam =
      typeof req.query['priority'] === 'string' &&
      (PRIORITIES as readonly string[]).includes(req.query['priority'])
        ? (req.query['priority'] as Priority)
        : undefined;
    const kindParam =
      typeof req.query['kind'] === 'string' &&
      (REQUEST_KINDS as readonly string[]).includes(req.query['kind'])
        ? req.query['kind']
        : undefined;
    const dueBefore =
      typeof req.query['dueBefore'] === 'string' && DATE_RE.test(req.query['dueBefore'])
        ? req.query['dueBefore']
        : undefined;
    const dueAfter =
      typeof req.query['dueAfter'] === 'string' && DATE_RE.test(req.query['dueAfter'])
        ? req.query['dueAfter']
        : undefined;
    const search =
      typeof req.query['search'] === 'string' && req.query['search'].trim().length > 0
        ? req.query['search'].trim()
        : undefined;
    const tag =
      typeof req.query['tag'] === 'string' && req.query['tag'].trim().length > 0
        ? req.query['tag'].trim()
        : undefined;
    const sortCol =
      typeof req.query['sort'] === 'string' &&
      ['created_at', 'due_date', 'priority', 'status', 'title'].includes(req.query['sort'])
        ? req.query['sort']
        : 'created_at';
    const dir = req.query['dir'] === 'asc' ? 'asc' : 'desc';
    const limit = Math.min(200, Math.max(1, Number(req.query['limit'] ?? 50)));
    const offset = Math.max(0, Number(req.query['offset'] ?? 0));

    const conds = [eq(clientRequests.firmId, session.firmId)];
    // 0165 — hide requests whose engagement belongs to a restricted client
    // the caller can't access. engagement_id is NOT NULL on client_request.
    const blockedClientIds = await getBlockedClientIdsCached(
      deps,
      req,
      session.appUserId,
      session.firmId,
    );
    if (blockedClientIds.length) {
      const blockedEngs = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(inArray(engagements.clientId, blockedClientIds));
      if (blockedEngs.length) {
        conds.push(
          notInArray(
            clientRequests.engagementId,
            blockedEngs.map((e) => e.id),
          ),
        );
      }
    }
    // 0198 — PENDING (scheduled) requests are hidden from the default queue;
    // the "Scheduled" view opts in with an explicit status=PENDING.
    if (status) conds.push(eq(clientRequests.status, status));
    else conds.push(ne(clientRequests.status, 'PENDING'));
    if (engagementIdParam) conds.push(eq(clientRequests.engagementId, engagementIdParam));
    if (assignedParam) conds.push(eq(clientRequests.assignedAppUserId, assignedParam));
    if (priorityParam) conds.push(eq(clientRequests.priority, priorityParam));
    if (kindParam) conds.push(eq(clientRequests.kind, kindParam));
    if (dueBefore) conds.push(sql`${clientRequests.dueDate} <= ${dueBefore}`);
    if (dueAfter) conds.push(sql`${clientRequests.dueDate} >= ${dueAfter}`);
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      conds.push(
        sql`(${clientRequests.title} ILIKE ${pattern} OR ${clientRequests.body} ILIKE ${pattern})`,
      );
    }
    if (tag) {
      conds.push(sql`${clientRequests.tags} @> ${JSON.stringify([tag])}::jsonb`);
    }
    // clientId requires the engagement join.
    const useClientJoin = Boolean(clientIdParam);
    const baseQ = useClientJoin
      ? deps.db
          .select({ row: clientRequests })
          .from(clientRequests)
          .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
          .where(and(...conds, eq(engagements.clientId, clientIdParam!)))
      : deps.db
          .select({ row: clientRequests })
          .from(clientRequests)
          .where(and(...conds));
    const orderExpr = (() => {
      const col =
        sortCol === 'due_date'
          ? clientRequests.dueDate
          : sortCol === 'priority'
            ? clientRequests.priority
            : sortCol === 'status'
              ? clientRequests.status
              : sortCol === 'title'
                ? clientRequests.title
                : clientRequests.createdAt;
      return dir === 'asc' ? asc(col) : desc(col);
    })();
    const rows = await baseQ.orderBy(orderExpr).limit(limit).offset(offset);
    const items = rows.map((r) => r.row);
    const totalQ = useClientJoin
      ? deps.db
          .select({ c: sql<number>`COUNT(*)::int` })
          .from(clientRequests)
          .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
          .where(and(...conds, eq(engagements.clientId, clientIdParam!)))
      : deps.db
          .select({ c: sql<number>`COUNT(*)::int` })
          .from(clientRequests)
          .where(and(...conds));
    const totalRows = await totalQ;
    const total = totalRows[0]?.c ?? 0;
    if (items.length === 0) {
      res.json({ items: [], total });
      return;
    }
    // P2.5 / G.8 — enrich each row with its accepted linked time entry
    // (if any) so the firm-wide queue can render "Linked: X hrs by …"
    // inline without N+1 calls. Left join: most rows have no link.
    const linkRows = await deps.db
      .select({
        clientRequestId: clientRequestTimeEntryLinks.clientRequestId,
        timeEntryId: timeEntries.id,
        hours: timeEntries.hours,
        entryDate: timeEntries.entryDate,
        staffName: appUsers.fullName,
      })
      .from(clientRequestTimeEntryLinks)
      .innerJoin(timeEntries, eq(timeEntries.id, clientRequestTimeEntryLinks.timeEntryId))
      .leftJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
      .where(
        and(
          sql`${clientRequestTimeEntryLinks.acceptedAt} IS NOT NULL`,
          sql`${clientRequestTimeEntryLinks.timeEntryId} IS NOT NULL`,
          inArray(
            clientRequestTimeEntryLinks.clientRequestId,
            items.map((i) => i.id),
          ),
        ),
      );
    const linkByRequest = new Map<string, (typeof linkRows)[number]>();
    for (const r of linkRows) linkByRequest.set(r.clientRequestId, r);
    const enriched = items.map((it) => {
      const link = linkByRequest.get(it.id);
      return {
        ...it,
        linkedTimeEntry: link
          ? {
              id: link.timeEntryId,
              hours: link.hours,
              entryDate: link.entryDate,
              staffName: link.staffName,
            }
          : null,
      };
    });
    res.json({ items: enriched, total });
  });

  // 0197 — count of requests with an UNREAD client response (client replied,
  // still open, staff hasn't opened it). Drives the Requests nav highlight.
  router.get(
    '/client-responses/unread-count',
    requirePermission(deps, 'requests:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ count: 0 });
        return;
      }
      // 0165 — exclude requests on clients this staffer is restricted from,
      // so the nav badge never counts hidden clients' responses.
      const countConds = [
        eq(clientRequests.firmId, session.firmId),
        sql`${clientRequests.clientReplyText} IS NOT NULL`,
        isNull(clientRequests.clientReplySeenAt),
        inArray(clientRequests.status, ['OPEN', 'NEEDS_INFO']),
      ];
      const blockedClientIds = await getBlockedClientIdsCached(
        deps,
        req,
        session.appUserId,
        session.firmId,
      );
      if (blockedClientIds.length) {
        const blockedEngs = await deps.db
          .select({ id: engagements.id })
          .from(engagements)
          .where(inArray(engagements.clientId, blockedClientIds));
        if (blockedEngs.length) {
          countConds.push(
            notInArray(
              clientRequests.engagementId,
              blockedEngs.map((e) => e.id),
            ),
          );
        }
      }
      const [row] = await deps.db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(clientRequests)
        .where(and(...countConds));
      res.json({ count: row?.c ?? 0 });
    },
  );

  router.get(
    '/:id',
    requirePermission(deps, 'requests:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(clientRequests)
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // 0197 — opening the detail marks an unread client reply as seen (clears
      // the Requests nav highlight).
      if (row.clientReplyText && !row.clientReplySeenAt) {
        await deps.db
          .update(clientRequests)
          .set({ clientReplySeenAt: new Date() })
          .where(eq(clientRequests.id, row.id));
      }
      // P2.3 — resolve the linked time entry (if any) for the request's
      // accepted suggestion. Surfaces in the staff request-detail UI as
      // "Linked time entry: X hrs by [staff]" per G.8.
      const linkedRows = await deps.db
        .select({
          timeEntryId: timeEntries.id,
          hours: timeEntries.hours,
          entryDate: timeEntries.entryDate,
          appUserId: timeEntries.appUserId,
          staffName: appUsers.fullName,
        })
        .from(clientRequestTimeEntryLinks)
        .innerJoin(timeEntries, eq(timeEntries.id, clientRequestTimeEntryLinks.timeEntryId))
        .leftJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
        .where(
          and(
            eq(clientRequestTimeEntryLinks.clientRequestId, row.id),
            sql`${clientRequestTimeEntryLinks.timeEntryId} IS NOT NULL`,
            sql`${clientRequestTimeEntryLinks.acceptedAt} IS NOT NULL`,
          ),
        )
        .limit(1);
      const linkedTimeEntry = linkedRows[0]
        ? {
            id: linkedRows[0].timeEntryId,
            hours: linkedRows[0].hours,
            entryDate: linkedRows[0].entryDate,
            staffName: linkedRows[0].staffName,
          }
        : null;
      // Which client this request relates to (via its engagement).
      const [engRow] = await deps.db
        .select({
          engagementName: engagements.name,
          clientId: engagements.clientId,
          clientName: clients.name,
        })
        .from(engagements)
        .leftJoin(clients, eq(clients.id, engagements.clientId))
        .where(eq(engagements.id, row.engagementId))
        .limit(1);
      res.json({
        request: row,
        linkedTimeEntry,
        engagementName: engRow?.engagementName ?? null,
        clientId: engRow?.clientId ?? null,
        clientName: engRow?.clientName ?? null,
      });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      // Cross-firm guard: engagement must belong to a client in this firm.
      const [eng] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId, name: engagements.name })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(eq(engagements.id, parsed.data.engagementId), eq(clients.firmId, session.firmId)),
        )
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }

      // 0084 — template resolution. When templateId is sent, load it +
      // its items, then spawn via the pure helper. Explicit fields in
      // the body always override template defaults.
      let resolvedTitle = parsed.data.title?.trim() ?? '';
      let resolvedBody = parsed.data.body ?? '';
      let resolvedPriority: Priority = parsed.data.priority ?? 'MEDIUM';
      let resolvedDueDate: string | null = parsed.data.dueDate ?? null;
      let resolvedReminder: number | null = parsed.data.reminderDaysBefore ?? null;
      let resolvedAssignee: string | null = parsed.data.assignedAppUserId ?? null;
      let resolvedItems: Array<{
        ordinal: number;
        label: string;
        body: string;
        itemKind: 'QUESTION' | 'DOCUMENT' | 'SIGNATURE';
        required: boolean;
        dueDate: string | null;
      }> = (parsed.data.items ?? []).map((i) => ({
        ordinal: i.ordinal,
        label: i.label,
        body: i.body ?? '',
        itemKind: i.itemKind,
        required: i.required,
        dueDate: i.dueDate ?? null,
      }));
      if (parsed.data.templateId) {
        const [tpl] = await deps.db
          .select()
          .from(requestTemplates)
          .where(
            and(
              eq(requestTemplates.id, parsed.data.templateId),
              eq(requestTemplates.firmId, session.firmId),
            ),
          )
          .limit(1);
        if (!tpl) {
          res.status(404).json({ error: 'template_not_found' });
          return;
        }
        const tplItems = await deps.db
          .select()
          .from(requestTemplateItems)
          .where(eq(requestTemplateItems.templateId, tpl.id))
          .orderBy(asc(requestTemplateItems.ordinal));
        const [clientRow] = await deps.db
          .select({ name: clients.name })
          .from(clients)
          .where(eq(clients.id, eng.clientId))
          .limit(1);
        const spawn = spawnFromTemplate(
          {
            id: tpl.id,
            titlePattern: tpl.titlePattern,
            bodyPattern: tpl.bodyPattern,
            defaultPriority: tpl.defaultPriority as Priority,
            defaultDueOffsetDays: tpl.defaultDueOffsetDays,
            defaultReminderDaysBefore: tpl.defaultReminderDaysBefore,
            defaultAssignedAppUserId: tpl.defaultAssignedAppUserId,
            items: tplItems.map((it) => ({
              ordinal: it.ordinal,
              label: it.label,
              body: it.body,
              itemKind: it.itemKind as 'QUESTION' | 'DOCUMENT' | 'SIGNATURE',
              required: it.required,
              defaultDueOffsetDays: it.defaultDueOffsetDays,
            })),
          },
          {
            clientName: clientRow?.name ?? null,
            engagementName: eng.name,
            today: new Date().toISOString().slice(0, 10),
          },
          {
            titleOverride: parsed.data.title?.trim() || undefined,
            bodyOverride: parsed.data.body || undefined,
            priorityOverride: parsed.data.priority,
            dueDateOverride: parsed.data.dueDate ?? undefined,
            reminderDaysBeforeOverride: parsed.data.reminderDaysBefore ?? undefined,
            assignedAppUserIdOverride: parsed.data.assignedAppUserId ?? undefined,
            tags: parsed.data.tags,
          },
        );
        resolvedTitle = spawn.title;
        resolvedBody = spawn.body;
        resolvedPriority = spawn.priority;
        resolvedDueDate = spawn.dueDate;
        resolvedReminder = spawn.reminderDaysBefore;
        resolvedAssignee = spawn.assignedAppUserId;
        // If caller didn't pass items, use the template's items.
        if (resolvedItems.length === 0) resolvedItems = spawn.items;
      }
      if (resolvedTitle.length === 0) {
        res.status(400).json({ error: 'title_required' });
        return;
      }
      // A drop-off is defined by its dated reminder — without a due date
      // (and a reminder lead) the worker sweep can never fire it, so the
      // request would be silently inert. Enforce server-side (the UI also
      // requires it, but MCP/bulk callers bypass the UI).
      // A drop-off's reminder can be either the legacy single lead
      // (reminderDaysBefore) or a multi-step schedule (reminderSchedule).
      const resolvedSchedule =
        parsed.data.reminderSchedule && parsed.data.reminderSchedule.length > 0
          ? parsed.data.reminderSchedule
          : null;
      if (parsed.data.kind === 'DROP_OFF') {
        if (!resolvedDueDate) {
          res.status(400).json({ error: 'due_date_required_for_drop_off' });
          return;
        }
        if (resolvedReminder === null && !resolvedSchedule) {
          res.status(400).json({ error: 'reminder_required_for_drop_off' });
          return;
        }
        // Default the assignee to the engagement's first-listed assignee
        // (earliest assignedAt — the order the engagement detail shows them)
        // when the caller didn't set one explicitly / via template.
        if (!resolvedAssignee) {
          const [firstAssignee] = await deps.db
            .select({ appUserId: engagementAssignments.appUserId })
            .from(engagementAssignments)
            .where(eq(engagementAssignments.engagementId, parsed.data.engagementId))
            .orderBy(asc(engagementAssignments.assignedAt))
            .limit(1);
          if (firstAssignee) resolvedAssignee = firstAssignee.appUserId;
        }
      }

      const newId = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(clientRequests)
          .values({
            firmId: session.firmId,
            engagementId: parsed.data.engagementId,
            assignedAppUserId: resolvedAssignee,
            title: resolvedTitle,
            body: resolvedBody,
            kind: parsed.data.kind,
            dueDate: resolvedDueDate,
            createdByAppUserId: session.appUserId,
            priority: resolvedPriority,
            tags: parsed.data.tags ?? [],
            templateId: parsed.data.templateId ?? null,
            reminderDaysBefore: resolvedReminder,
            reminderSchedule: resolvedSchedule,
            // 0220 — where portal DOCUMENT-item uploads land.
            targetSubfolderPath: normalizeSubfolder(parsed.data.targetSubfolderPath, 'other'),
            // 0198 — an activation date makes the request start hidden (PENDING).
            ...(parsed.data.activationDate
              ? { status: 'PENDING' as const, activationDate: parsed.data.activationDate }
              : {}),
          })
          .returning({ id: clientRequests.id });
        if (!row) throw new Error('insert_failed');
        if (resolvedItems.length > 0) {
          await tx.insert(clientRequestItems).values(
            resolvedItems.map((it) => ({
              clientRequestId: row.id,
              ordinal: it.ordinal,
              label: it.label,
              body: it.body,
              itemKind: it.itemKind,
              required: it.required,
              dueDate: it.dueDate,
            })),
          );
        }
        // 0204 — a drop-off's due date is the "drop date"; back-fill the
        // engagement's due date from it when the engagement has none.
        if (parsed.data.kind === 'DROP_OFF' && resolvedDueDate) {
          await applyDropoffDueDate(
            tx as unknown as Database,
            session.firmId,
            parsed.data.engagementId,
            resolvedDueDate,
          );
        }
        return row.id;
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_request',
        entityId: newId,
        actorAppUserId: session.appUserId,
        after: { ...parsed.data, resolvedTitle, itemCount: resolvedItems.length },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: newId });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      // Re-attach engagement: cross-firm guard.
      if (parsed.data.engagementId !== undefined) {
        const [eng] = await deps.db
          .select({ id: engagements.id })
          .from(engagements)
          .innerJoin(clients, eq(clients.id, engagements.clientId))
          .where(
            and(eq(engagements.id, parsed.data.engagementId), eq(clients.firmId, session.firmId)),
          )
          .limit(1);
        if (!eng) {
          res.status(404).json({ error: 'engagement_not_found' });
          return;
        }
      }
      // Load the current row for firm-scope + PENDING activation math.
      const [existing] = await deps.db
        .select({
          id: clientRequests.id,
          status: clientRequests.status,
          kind: clientRequests.kind,
          engagementId: clientRequests.engagementId,
          dueDate: clientRequests.dueDate,
          reminderDaysBefore: clientRequests.reminderDaysBefore,
        })
        .from(clientRequests)
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.title !== undefined) patch['title'] = parsed.data.title;
      if (parsed.data.body !== undefined) patch['body'] = parsed.data.body;
      if (parsed.data.assignedAppUserId !== undefined) {
        patch['assignedAppUserId'] = parsed.data.assignedAppUserId;
      }
      if (parsed.data.dueDate !== undefined) patch['dueDate'] = parsed.data.dueDate;
      if (parsed.data.engagementId !== undefined) patch['engagementId'] = parsed.data.engagementId;
      if (parsed.data.priority !== undefined) patch['priority'] = parsed.data.priority;
      if (parsed.data.tags !== undefined) patch['tags'] = parsed.data.tags;
      if (parsed.data.reminderDaysBefore !== undefined)
        patch['reminderDaysBefore'] = parsed.data.reminderDaysBefore;
      // Status edit. PENDING = scheduled/hidden: compute an activation date
      // (due date minus the reminder lead) so the worker later flips it OPEN;
      // moving to any other status clears the schedule and stamps activation.
      if (parsed.data.status !== undefined && parsed.data.status !== existing.status) {
        patch['status'] = parsed.data.status;
        if (parsed.data.status === 'PENDING') {
          const effDue =
            parsed.data.dueDate !== undefined
              ? parsed.data.dueDate
              : existing.dueDate
                ? String(existing.dueDate)
                : null;
          const effReminder =
            parsed.data.reminderDaysBefore !== undefined
              ? parsed.data.reminderDaysBefore
              : (existing.reminderDaysBefore ?? 0);
          let activationDate: string | null = null;
          if (effDue) {
            const dueMs = Date.parse(`${effDue}T00:00:00Z`);
            activationDate = Number.isFinite(dueMs)
              ? new Date(dueMs - (effReminder ?? 0) * 86_400_000).toISOString().slice(0, 10)
              : effDue;
          }
          patch['activationDate'] = activationDate;
          patch['activatedAt'] = null;
        } else {
          patch['activationDate'] = null;
          if (existing.status === 'PENDING') patch['activatedAt'] = new Date();
        }
      }
      const updated = await deps.db
        .update(clientRequests)
        .set(patch)
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .returning({ id: clientRequests.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // 0204 — editing a drop-off's date back-fills the engagement due date
      // when it has none (same rule as create).
      if (existing.kind === 'DROP_OFF' && parsed.data.dueDate) {
        const engId = parsed.data.engagementId ?? existing.engagementId;
        if (engId) {
          await applyDropoffDueDate(deps.db, session.firmId, engId, parsed.data.dueDate).catch(
            (err: unknown) => logger.error({ err }, 'dropoff due-date backfill failed'),
          );
        }
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_request',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: patch,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/fulfill',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const parsed = FulfillSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const expirationDays = await getSuggestionExpirationDays(deps.db, session.firmId);
      const expiresAt = new Date(Date.now() + expirationDays * 86_400_000);
      const result = await deps.db.transaction(async (tx) => {
        const [prior] = await tx
          .select()
          .from(clientRequests)
          .where(
            and(
              eq(clientRequests.id, req.params['id']!),
              eq(clientRequests.firmId, session.firmId),
            ),
          )
          .for('update')
          .limit(1);
        if (!prior) return { kind: 'not_found' as const };
        if (prior.status !== 'OPEN') return { kind: 'wrong_status' as const, status: prior.status };
        await tx
          .update(clientRequests)
          .set({
            status: 'FULFILLED',
            fulfilledAt: new Date(),
            fulfilledByAppUserId: session.appUserId,
            fulfilledByMessageId: parsed.data.messageId ?? null,
            fulfilledByFileId: parsed.data.fileId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(clientRequests.id, prior.id));
        // Queue a time-entry suggestion for the assigned staff. If the
        // request had no assignee, suggest to the fulfiller.
        const suggestedFor = prior.assignedAppUserId ?? session.appUserId;
        const [linkRow] = await tx
          .insert(clientRequestTimeEntryLinks)
          .values({
            clientRequestId: prior.id,
            suggestedForAppUserId: suggestedFor,
            expiresAt,
          })
          .returning({ id: clientRequestTimeEntryLinks.id });
        return { kind: 'ok' as const, suggestionId: linkRow?.id };
      });
      if (result.kind === 'not_found') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (result.kind === 'wrong_status') {
        res.status(409).json({ error: 'wrong_status', status: result.status });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_request',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'fulfill',
          messageId: parsed.data.messageId,
          fileId: parsed.data.fileId,
          suggestionId: result.suggestionId,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, suggestionId: result.suggestionId });
    },
  );

  router.post(
    '/:id/dismiss',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const parsed = DismissSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const updated = await deps.db
        .update(clientRequests)
        .set({
          status: 'DISMISSED',
          dismissedAt: new Date(),
          dismissedReason: parsed.data.reason ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(clientRequests.id, req.params['id']!),
            eq(clientRequests.firmId, session.firmId),
            eq(clientRequests.status, 'OPEN'),
          ),
        )
        .returning({ id: clientRequests.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found_or_wrong_status' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_request',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { kind: 'dismiss', reason: parsed.data.reason },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/reopen',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const updated = await deps.db
        .update(clientRequests)
        .set({
          status: 'OPEN',
          dismissedAt: null,
          dismissedReason: null,
          fulfilledAt: null,
          fulfilledByAppUserId: null,
          fulfilledByPortalIdentityId: null,
          fulfilledByMessageId: null,
          fulfilledByFileId: null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .returning({ id: clientRequests.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'RESTORE',
        entityType: 'client_request',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // 0198 — activate a PENDING (scheduled) request now: make it visible/OPEN.
  // The client then sees it in the portal and enters the reminder schedule;
  // scheduled activation by the worker also emails a "new request" submit.
  router.post(
    '/:id/activate',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const updated = await deps.db
        .update(clientRequests)
        .set({
          status: 'OPEN',
          activatedAt: new Date(),
          activationDate: today,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(clientRequests.id, req.params['id']!),
            eq(clientRequests.firmId, session.firmId),
            eq(clientRequests.status, 'PENDING'),
          ),
        )
        .returning({ id: clientRequests.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found_or_not_pending' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_request',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: 'OPEN', activated: 'manual' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // -------------------------------------------------------------------
  // 0084 — needs-info status flip (staff side; the portal flips via
  // /api/portal/requests/:id/needs-info).
  // -------------------------------------------------------------------
  router.post(
    '/:id/needs-info',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = NeedsInfoSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const updated = await deps.db
        .update(clientRequests)
        .set({
          status: 'NEEDS_INFO',
          clientReplyText: parsed.data.text,
          // Staff authored this note, so it isn't an unread client response.
          clientReplySeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .returning({ id: clientRequests.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_request',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: 'NEEDS_INFO' },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // -------------------------------------------------------------------
  // 0084 — bulk send: one template → N clients/engagements in one call.
  // -------------------------------------------------------------------
  router.post(
    '/bulk',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = BulkSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const [tpl] = await deps.db
        .select()
        .from(requestTemplates)
        .where(
          and(
            eq(requestTemplates.id, parsed.data.templateId),
            eq(requestTemplates.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!tpl) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }
      const tplItems = await deps.db
        .select()
        .from(requestTemplateItems)
        .where(eq(requestTemplateItems.templateId, tpl.id))
        .orderBy(asc(requestTemplateItems.ordinal));
      const today = new Date().toISOString().slice(0, 10);
      const created: string[] = [];
      const skipped: Array<{ clientId: string; reason: string }> = [];
      for (const target of parsed.data.targets) {
        const [eng] = await deps.db
          .select({ id: engagements.id, clientId: engagements.clientId, name: engagements.name })
          .from(engagements)
          .innerJoin(clients, eq(clients.id, engagements.clientId))
          .where(and(eq(engagements.id, target.engagementId), eq(clients.firmId, session.firmId)))
          .limit(1);
        if (!eng || eng.clientId !== target.clientId) {
          skipped.push({ clientId: target.clientId, reason: 'engagement_cross_firm_or_mismatch' });
          continue;
        }
        const [clientRow] = await deps.db
          .select({ name: clients.name })
          .from(clients)
          .where(eq(clients.id, target.clientId))
          .limit(1);
        const spawn = spawnFromTemplate(
          {
            id: tpl.id,
            titlePattern: tpl.titlePattern,
            bodyPattern: tpl.bodyPattern,
            defaultPriority: tpl.defaultPriority as Priority,
            defaultDueOffsetDays: tpl.defaultDueOffsetDays,
            defaultReminderDaysBefore: tpl.defaultReminderDaysBefore,
            defaultAssignedAppUserId: tpl.defaultAssignedAppUserId,
            items: tplItems.map((it) => ({
              ordinal: it.ordinal,
              label: it.label,
              body: it.body,
              itemKind: it.itemKind as 'QUESTION' | 'DOCUMENT' | 'SIGNATURE',
              required: it.required,
              defaultDueOffsetDays: it.defaultDueOffsetDays,
            })),
          },
          { clientName: clientRow?.name ?? null, engagementName: eng.name, today },
          {
            dueDateOverride: target.dueDateOverride ?? undefined,
            priorityOverride: target.priorityOverride,
            assignedAppUserIdOverride: target.assignedAppUserIdOverride ?? undefined,
            tags: target.tags,
          },
        );
        try {
          const newId = await deps.db.transaction(async (tx) => {
            const [row] = await tx
              .insert(clientRequests)
              .values({
                firmId: session.firmId,
                engagementId: eng.id,
                assignedAppUserId: spawn.assignedAppUserId,
                title: spawn.title,
                body: spawn.body,
                dueDate: spawn.dueDate,
                createdByAppUserId: session.appUserId,
                priority: spawn.priority,
                tags: spawn.tags,
                templateId: tpl.id,
                reminderDaysBefore: spawn.reminderDaysBefore,
              })
              .returning({ id: clientRequests.id });
            if (!row) throw new Error('insert_failed');
            if (spawn.items.length > 0) {
              await tx.insert(clientRequestItems).values(
                spawn.items.map((it) => ({
                  clientRequestId: row.id,
                  ordinal: it.ordinal,
                  label: it.label,
                  body: it.body,
                  itemKind: it.itemKind,
                  required: it.required,
                  dueDate: it.dueDate,
                })),
              );
            }
            return row.id;
          });
          created.push(newId);
        } catch (err) {
          skipped.push({
            clientId: target.clientId,
            reason: err instanceof Error ? err.message : 'insert_failed',
          });
        }
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_request',
        entityId: null,
        actorAppUserId: session.appUserId,
        after: { bulk: true, templateId: tpl.id, created: created.length, skipped: skipped.length },
      }).catch(() => undefined);
      res.status(201).json({ created: created.length, requestIds: created, skipped });
    },
  );

  // -------------------------------------------------------------------
  // 0084 — items endpoints (staff side; portal has its own per-item
  // fulfill in apps/api/src/portal/requests.ts).
  // -------------------------------------------------------------------
  router.get(
    '/:id/items',
    requirePermission(deps, 'requests:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [parent] = await deps.db
        .select({ id: clientRequests.id })
        .from(clientRequests)
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .limit(1);
      if (!parent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select()
        .from(clientRequestItems)
        .where(eq(clientRequestItems.clientRequestId, parent.id))
        .orderBy(asc(clientRequestItems.ordinal));
      res.json({ items });
    },
  );

  router.patch(
    '/:id/items/:itemId',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ItemPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const [parent] = await deps.db
        .select({ id: clientRequests.id })
        .from(clientRequests)
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .limit(1);
      if (!parent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.label !== undefined) patch['label'] = parsed.data.label;
      if (parsed.data.body !== undefined) patch['body'] = parsed.data.body;
      if (parsed.data.dueDate !== undefined) patch['dueDate'] = parsed.data.dueDate;
      const updated = await deps.db
        .update(clientRequestItems)
        .set(patch)
        .where(
          and(
            eq(clientRequestItems.id, req.params['itemId']!),
            eq(clientRequestItems.clientRequestId, parent.id),
          ),
        )
        .returning({ id: clientRequestItems.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'item_not_found' });
        return;
      }
      res.json({ ok: true });
    },
  );

  // Delete a checklist item from a request.
  router.delete(
    '/:id/items/:itemId',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [parent] = await deps.db
        .select({ id: clientRequests.id })
        .from(clientRequests)
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .limit(1);
      if (!parent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const deleted = await deps.db
        .delete(clientRequestItems)
        .where(
          and(
            eq(clientRequestItems.id, req.params['itemId']!),
            eq(clientRequestItems.clientRequestId, parent.id),
          ),
        )
        .returning({ id: clientRequestItems.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: 'item_not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_request',
        entityId: parent.id,
        actorAppUserId: session.appUserId,
        after: { deletedItemId: req.params['itemId'] },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/items/:itemId/fulfill',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ItemFulfillSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const [parent] = await deps.db
        .select({ id: clientRequests.id })
        .from(clientRequests)
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .limit(1);
      if (!parent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const updated = await deps.db
        .update(clientRequestItems)
        .set({
          status: 'FULFILLED',
          fulfilledAt: new Date(),
          fulfilledByAppUserId: session.appUserId,
          fulfilledByFileId: parsed.data.fileId ?? null,
          fulfilledText: parsed.data.text ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(clientRequestItems.id, req.params['itemId']!),
            eq(clientRequestItems.clientRequestId, parent.id),
          ),
        )
        .returning({ id: clientRequestItems.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'item_not_found' });
        return;
      }
      // Roll-up: if every REQUIRED item is FULFILLED, flip the parent to FULFILLED.
      const remaining = await deps.db
        .select({ id: clientRequestItems.id })
        .from(clientRequestItems)
        .where(
          and(
            eq(clientRequestItems.clientRequestId, parent.id),
            eq(clientRequestItems.required, true),
            sql`${clientRequestItems.status} != 'FULFILLED'`,
          ),
        )
        .limit(1);
      if (remaining.length === 0) {
        await deps.db
          .update(clientRequests)
          .set({
            status: 'FULFILLED',
            fulfilledAt: new Date(),
            fulfilledByAppUserId: session.appUserId,
            updatedAt: new Date(),
          })
          .where(eq(clientRequests.id, parent.id));
      }
      res.json({ ok: true });
    },
  );

  // -------------------------------------------------------------------
  // Suggestion queue (per-staff)
  // -------------------------------------------------------------------
  router.get(
    '/suggestions/mine',
    requirePermission(deps, 'requests:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({
          id: clientRequestTimeEntryLinks.id,
          clientRequestId: clientRequestTimeEntryLinks.clientRequestId,
          suggestedAt: clientRequestTimeEntryLinks.suggestedAt,
          expiresAt: clientRequestTimeEntryLinks.expiresAt,
          requestTitle: clientRequests.title,
          engagementId: clientRequests.engagementId,
        })
        .from(clientRequestTimeEntryLinks)
        .innerJoin(
          clientRequests,
          eq(clientRequests.id, clientRequestTimeEntryLinks.clientRequestId),
        )
        .where(
          and(
            eq(clientRequestTimeEntryLinks.suggestedForAppUserId, session.appUserId),
            eq(clientRequests.firmId, session.firmId),
            isNull(clientRequestTimeEntryLinks.acceptedAt),
            isNull(clientRequestTimeEntryLinks.dismissedAt),
          ),
        )
        .orderBy(asc(clientRequestTimeEntryLinks.expiresAt));
      res.json({ items });
    },
  );

  router.post(
    '/suggestions/:id/accept',
    requirePermission(deps, 'requests:read'),
    async (req: Request, res: Response) => {
      const parsed = AcceptSuggestionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      // A suggestion needs a time_entry_id to satisfy the state check
      // constraint. Reject accept without it.
      if (!parsed.data.timeEntryId) {
        res.status(400).json({ error: 'time_entry_id_required' });
        return;
      }
      const updated = await deps.db
        .update(clientRequestTimeEntryLinks)
        .set({
          acceptedAt: new Date(),
          timeEntryId: parsed.data.timeEntryId,
        })
        .where(
          and(
            eq(clientRequestTimeEntryLinks.id, req.params['id']!),
            eq(clientRequestTimeEntryLinks.suggestedForAppUserId, session.appUserId),
            isNull(clientRequestTimeEntryLinks.acceptedAt),
            isNull(clientRequestTimeEntryLinks.dismissedAt),
          ),
        )
        .returning({ id: clientRequestTimeEntryLinks.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found_or_already_resolved' });
        return;
      }
      res.json({ ok: true });
    },
  );

  router.post(
    '/suggestions/:id/dismiss',
    requirePermission(deps, 'requests:read'),
    async (req: Request, res: Response) => {
      const parsed = DismissSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const updated = await deps.db
        .update(clientRequestTimeEntryLinks)
        .set({
          dismissedAt: new Date(),
          dismissedReason: parsed.data.reason ?? null,
        })
        .where(
          and(
            eq(clientRequestTimeEntryLinks.id, req.params['id']!),
            eq(clientRequestTimeEntryLinks.suggestedForAppUserId, session.appUserId),
            isNull(clientRequestTimeEntryLinks.acceptedAt),
            isNull(clientRequestTimeEntryLinks.dismissedAt),
          ),
        )
        .returning({ id: clientRequestTimeEntryLinks.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found_or_already_resolved' });
        return;
      }
      res.json({ ok: true });
    },
  );

  return router;
}
