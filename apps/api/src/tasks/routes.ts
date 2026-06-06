// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Firm-wide task list (top-level "Tasks" view). The per-client task CRUD
// lives at /clients/:id/tasks (see ../clients/tasks.ts); this router adds a
// cross-client, firm-scoped surface so staff can see "my tasks" across all
// clients and managers can see every open task, plus create a task without
// first navigating to a client. All endpoints are scoped to the caller's
// firm via req.staffSession.firmId.

import { z } from 'zod';
import { and, asc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { type Request, type Response, type Router } from 'express';
import express from 'express';

import type { Database } from '@vibe/db';
import { appUsers, clientTasks, clients } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface TaskListRoutesDeps extends RbacDeps {
  db: Database | null;
}

const STATUSES = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELED'] as const;
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
type Status = (typeof STATUSES)[number];

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  engagementId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(STATUSES).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

const PatchSchema = CreateSchema.omit({ clientId: true }).partial();

async function clientInFirm(db: Database, clientId: string, firmId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  return Boolean(row);
}

function parseStatuses(raw: unknown): Status[] | 'all' | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.toUpperCase() === 'ALL') return 'all';
  const wanted = s
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter((x): x is Status => (STATUSES as readonly string[]).includes(x));
  return wanted.length ? wanted : null;
}

export function createTaskRouter(deps: TaskListRoutesDeps): Router {
  const router = express.Router();

  // GET / — firm-wide list with filters + joined client/assignee names.
  router.get('/', requirePermission(deps, 'client:read'), async (req: Request, res: Response) => {
    const firmId = req.staffSession?.firmId;
    const meId = req.staffSession?.appUserId;
    if (!firmId || !deps.db) {
      res.json({ items: [], total: 0 });
      return;
    }

    const scope = String(req.query['scope'] ?? 'mine') === 'all' ? 'all' : 'mine';
    const assigneeId =
      typeof req.query['assigneeId'] === 'string' && req.query['assigneeId']
        ? req.query['assigneeId']
        : null;
    const clientId =
      typeof req.query['clientId'] === 'string' && req.query['clientId']
        ? req.query['clientId']
        : null;
    const priorityRaw = String(req.query['priority'] ?? '').toUpperCase();
    const priority = (PRIORITIES as readonly string[]).includes(priorityRaw) ? priorityRaw : null;
    const overdue = req.query['overdue'] === '1' || req.query['overdue'] === 'true';
    const q = (req.query['q'] ?? '').toString().trim();
    const includeClosed =
      req.query['includeClosed'] === '1' || req.query['includeClosed'] === 'true';
    const statusFilter = parseStatuses(req.query['status']);

    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(String(req.query['pageSize'] ?? '50'), 10) || 50),
    );

    const conds = [eq(clientTasks.firmId, firmId)];

    // Assignee scoping: explicit assigneeId wins; otherwise scope=mine
    // restricts to the caller, scope=all shows everyone's.
    if (assigneeId) {
      conds.push(eq(clientTasks.assigneeUserId, assigneeId));
    } else if (scope === 'mine' && meId) {
      conds.push(eq(clientTasks.assigneeUserId, meId));
    }

    if (clientId) conds.push(eq(clientTasks.clientId, clientId));
    if (priority) conds.push(eq(clientTasks.priority, priority as (typeof PRIORITIES)[number]));

    // Status: explicit list/ALL overrides; else default to active only
    // unless includeClosed is set.
    if (statusFilter === 'all') {
      // no status constraint
    } else if (Array.isArray(statusFilter)) {
      conds.push(inArray(clientTasks.status, statusFilter));
    } else if (!includeClosed) {
      conds.push(sql`${clientTasks.status} NOT IN ('DONE', 'CANCELED')`);
    }

    if (overdue) {
      conds.push(sql`${clientTasks.dueDate} < CURRENT_DATE`);
      conds.push(sql`${clientTasks.status} NOT IN ('DONE', 'CANCELED')`);
    }
    if (q) conds.push(ilike(clientTasks.title, `%${q}%`));

    const where = and(...conds);

    const totalRows = await deps.db
      .select({ total: sql<number>`COUNT(*)`.as('total') })
      .from(clientTasks)
      .where(where);
    const total = Number(totalRows[0]?.total ?? 0);

    // Sort: active first, then by due date asc (nulls last), then priority
    // severity (URGENT → LOW), then newest.
    const priorityRank = sql`CASE ${clientTasks.priority}
      WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END`;

    const items = await deps.db
      .select({
        id: clientTasks.id,
        clientId: clientTasks.clientId,
        clientName: clients.name,
        engagementId: clientTasks.engagementId,
        assigneeUserId: clientTasks.assigneeUserId,
        assigneeName: appUsers.fullName,
        title: clientTasks.title,
        description: clientTasks.description,
        priority: clientTasks.priority,
        status: clientTasks.status,
        dueDate: clientTasks.dueDate,
        createdAt: clientTasks.createdAt,
        completedAt: clientTasks.completedAt,
      })
      .from(clientTasks)
      .leftJoin(clients, eq(clients.id, clientTasks.clientId))
      .leftJoin(appUsers, eq(appUsers.id, clientTasks.assigneeUserId))
      .where(where)
      .orderBy(
        sql`CASE WHEN ${clientTasks.status} IN ('DONE','CANCELED') THEN 1 ELSE 0 END`,
        sql`${clientTasks.dueDate} ASC NULLS LAST`,
        priorityRank,
        sql`${clientTasks.createdAt} DESC`,
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    res.json({ items, total, page, pageSize });
  });

  // GET /assignees — active staff for the assignee filter + create picker.
  // Gated client:read so it does not require the admin-only app_user:read.
  router.get(
    '/assignees',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ users: [] });
        return;
      }
      const users = await deps.db
        .select({ id: appUsers.id, fullName: appUsers.fullName })
        .from(appUsers)
        .where(and(eq(appUsers.firmId, firmId), eq(appUsers.status, 'ACTIVE')))
        .orderBy(asc(appUsers.fullName));
      res.json({ users });
    },
  );

  // POST / — create a task against a client chosen in the body.
  router.post('/', requirePermission(deps, 'client:write'), async (req: Request, res: Response) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const data = parsed.data;
    if (!(await clientInFirm(deps.db, data.clientId, firmId))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const [row] = await deps.db
      .insert(clientTasks)
      .values({
        firmId,
        clientId: data.clientId,
        engagementId: data.engagementId ?? null,
        assigneeUserId: data.assigneeUserId ?? null,
        title: data.title,
        description: data.description ?? null,
        priority: data.priority ?? 'MEDIUM',
        status: data.status ?? 'OPEN',
        dueDate: data.dueDate ?? null,
        createdById: req.staffSession!.appUserId,
      })
      .returning();
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'client_task',
      entityId: row?.id ?? null,
      actorAppUserId: req.staffSession!.appUserId,
      after: row
        ? {
            clientId: data.clientId,
            title: row.title,
            priority: row.priority,
            status: row.status,
            assigneeUserId: row.assigneeUserId,
          }
        : { clientId: data.clientId },
    }).catch(() => undefined);
    res.status(201).json({ task: row });
  });

  // PATCH /:taskId — update a task (firm-scoped; no client id in the URL).
  router.patch(
    '/:taskId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const taskId = req.params['taskId']!;
      const [existing] = await deps.db
        .select({ id: clientTasks.id })
        .from(clientTasks)
        .where(and(eq(clientTasks.id, taskId), eq(clientTasks.firmId, firmId)))
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const data = parsed.data;
      // If status flips to DONE, stamp completedAt; clear it otherwise.
      const completedAt = data.status === 'DONE' ? new Date() : data.status ? null : undefined;
      const [row] = await deps.db
        .update(clientTasks)
        .set({
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.engagementId !== undefined ? { engagementId: data.engagementId } : {}),
          ...(data.assigneeUserId !== undefined ? { assigneeUserId: data.assigneeUserId } : {}),
          ...(data.priority !== undefined ? { priority: data.priority } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.dueDate !== undefined ? { dueDate: data.dueDate } : {}),
          ...(completedAt !== undefined ? { completedAt } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(clientTasks.id, taskId), eq(clientTasks.firmId, firmId)))
        .returning();
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_task',
        entityId: taskId,
        actorAppUserId: req.staffSession!.appUserId,
        after: row ? { status: row.status, priority: row.priority } : null,
      }).catch(() => undefined);
      res.json({ task: row });
    },
  );

  // DELETE /:taskId — firm-scoped hard delete.
  router.delete(
    '/:taskId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const taskId = req.params['taskId']!;
      const [existing] = await deps.db
        .select({ id: clientTasks.id })
        .from(clientTasks)
        .where(and(eq(clientTasks.id, taskId), eq(clientTasks.firmId, firmId)))
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .delete(clientTasks)
        .where(and(eq(clientTasks.id, taskId), eq(clientTasks.firmId, firmId)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_task',
        entityId: taskId,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
