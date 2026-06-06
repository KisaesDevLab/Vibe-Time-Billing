// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Saved kanban "column views" (0122). Each row is a per-user named set of
// visible status columns for a board (today: the engagements board).
// Private to the owner — there is no shared flag. Mirrors the saved-report
// router but scoped strictly to the signing-in user's own rows.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { savedKanbanViews } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';

export interface KanbanViewRoutesDeps extends RbacDeps {
  db: Database | null;
}

const VisibleColumns = z.array(z.string().min(1).max(80)).max(100);

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  boardType: z.string().min(1).max(60).optional(),
  visibleColumns: VisibleColumns.default([]),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  visibleColumns: VisibleColumns.optional(),
});

export function createKanbanViewRouter(deps: KanbanViewRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // GET / — list the caller's own views (optionally filtered by boardType).
  router.get(
    '/',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const boardType = (req.query['boardType'] ?? '').toString();
      const conds = [eq(savedKanbanViews.ownerId, session.appUserId)];
      if (boardType) conds.push(eq(savedKanbanViews.boardType, boardType));
      const items = await deps.db
        .select()
        .from(savedKanbanViews)
        .where(and(...conds))
        .orderBy(asc(savedKanbanViews.name));
      res.json({ items });
    },
  );

  // POST / — create a new view owned by the caller.
  router.post(
    '/',
    requirePermission(deps, 'engagement:read'),
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
      try {
        const [row] = await deps.db
          .insert(savedKanbanViews)
          .values({
            firmId: session.firmId,
            ownerId: session.appUserId,
            name: parsed.data.name,
            boardType: parsed.data.boardType ?? 'engagement',
            visibleColumns: parsed.data.visibleColumns,
          })
          .returning();
        res.status(201).json({ view: row });
      } catch {
        // Unique (owner, board_type, name) collision.
        res.status(409).json({ error: 'name_taken' });
      }
    },
  );

  // PATCH /:id — rename and/or update the column set (owner only).
  router.patch(
    '/:id',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (parsed.data.name != null) patch['name'] = parsed.data.name;
      if (parsed.data.visibleColumns != null) patch['visibleColumns'] = parsed.data.visibleColumns;
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      patch['updatedAt'] = new Date();
      try {
        const updated = await deps.db
          .update(savedKanbanViews)
          .set(patch)
          .where(
            and(
              eq(savedKanbanViews.id, req.params['id']!),
              eq(savedKanbanViews.ownerId, session.appUserId),
            ),
          )
          .returning();
        if (updated.length === 0) {
          res.status(404).json({ error: 'not_found_or_not_owner' });
          return;
        }
        res.json({ view: updated[0] });
      } catch {
        res.status(409).json({ error: 'name_taken' });
      }
    },
  );

  // DELETE /:id — owner only.
  router.delete(
    '/:id',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const deleted = await deps.db
        .delete(savedKanbanViews)
        .where(
          and(
            eq(savedKanbanViews.id, req.params['id']!),
            eq(savedKanbanViews.ownerId, session.appUserId),
          ),
        )
        .returning({ id: savedKanbanViews.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: 'not_found_or_not_owner' });
        return;
      }
      res.json({ ok: true });
    },
  );

  return router;
}
