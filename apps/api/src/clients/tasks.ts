// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Per-client task CRUD (v2 Sprint C, workstream 1.3). Mounted on the
// client router at /clients/:id/tasks.

import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { type Request, type Response, type Router } from 'express';

import type { Database } from '@vibe/db';
import { clientTasks, clients } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { spawnRecurringFollowUp } from '../tasks/spawn-recurrence';

export interface TaskRoutesDeps extends RbacDeps {
  db: Database | null;
}

const TaskCreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  engagementId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELED']).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  recurrence: z
    .enum(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'])
    .nullable()
    .optional(),
});

const TaskPatchSchema = TaskCreateSchema.partial();

async function ensureClientInFirm(
  db: Database,
  clientId: string,
  firmId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  return Boolean(row);
}

export function mountTaskRoutes(router: Router, deps: TaskRoutesDeps): void {
  router.get(
    '/:id/tasks',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const clientId = req.params['id']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select()
        .from(clientTasks)
        .where(eq(clientTasks.clientId, clientId))
        .orderBy(desc(clientTasks.createdAt));
      res.json({ items });
    },
  );

  router.post(
    '/:id/tasks',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = TaskCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const clientId = req.params['id']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const data = parsed.data;
      const [row] = await deps.db
        .insert(clientTasks)
        .values({
          firmId,
          clientId,
          engagementId: data.engagementId ?? null,
          assigneeUserId: data.assigneeUserId ?? null,
          title: data.title,
          description: data.description ?? null,
          priority: data.priority ?? 'MEDIUM',
          status: data.status ?? 'OPEN',
          dueDate: data.dueDate ?? null,
          recurrence: data.recurrence ?? null,
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
              clientId,
              title: row.title,
              priority: row.priority,
              status: row.status,
              assigneeUserId: row.assigneeUserId,
            }
          : { clientId },
      }).catch(() => undefined);
      res.status(201).json({ task: row });
    },
  );

  router.patch(
    '/:id/tasks/:taskId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = TaskPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const clientId = req.params['id']!;
      const taskId = req.params['taskId']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [existing] = await deps.db
        .select()
        .from(clientTasks)
        .where(and(eq(clientTasks.id, taskId), eq(clientTasks.clientId, clientId)))
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const data = parsed.data;
      // If status flips to DONE, stamp completedAt.
      const completedAt = data.status === 'DONE' ? new Date() : data.status ? null : undefined;
      const actorId = req.staffSession!.appUserId;
      const db = deps.db;
      const { row, spawned } = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(clientTasks)
          .set({
            ...(data.title !== undefined ? { title: data.title } : {}),
            ...(data.description !== undefined ? { description: data.description } : {}),
            ...(data.engagementId !== undefined ? { engagementId: data.engagementId } : {}),
            ...(data.assigneeUserId !== undefined ? { assigneeUserId: data.assigneeUserId } : {}),
            ...(data.priority !== undefined ? { priority: data.priority } : {}),
            ...(data.status !== undefined ? { status: data.status } : {}),
            ...(data.dueDate !== undefined ? { dueDate: data.dueDate } : {}),
            ...(data.recurrence !== undefined ? { recurrence: data.recurrence } : {}),
            ...(completedAt !== undefined ? { completedAt } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(clientTasks.id, taskId), eq(clientTasks.clientId, clientId)))
          .returning();
        // Recurring tasks open their successor on the transition INTO DONE.
        const effectiveRecurrence =
          data.recurrence !== undefined ? data.recurrence : existing.recurrence;
        let spawnedId: string | null = null;
        if (
          data.status === 'DONE' &&
          existing.status !== 'DONE' &&
          effectiveRecurrence != null &&
          updated
        ) {
          spawnedId = await spawnRecurringFollowUp(
            tx,
            {
              id: updated.id,
              firmId: updated.firmId,
              clientId: updated.clientId,
              engagementId: updated.engagementId,
              assigneeUserId: updated.assigneeUserId,
              title: updated.title,
              description: updated.description,
              priority: updated.priority,
              recurrence: effectiveRecurrence,
              dueDate: updated.dueDate,
            },
            actorId,
          );
        }
        return { row: updated, spawned: spawnedId };
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_task',
        entityId: taskId,
        actorAppUserId: actorId,
        after: row ? { status: row.status, priority: row.priority } : null,
      }).catch(() => undefined);
      res.json({ task: row, spawned });
    },
  );

  router.delete(
    '/:id/tasks/:taskId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const clientId = req.params['id']!;
      const taskId = req.params['taskId']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .delete(clientTasks)
        .where(and(eq(clientTasks.id, taskId), eq(clientTasks.clientId, clientId)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_task',
        entityId: taskId,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );
}
