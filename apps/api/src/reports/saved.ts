// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Saved-report definitions (Phase 18 #21). Each row is a name + report
// kind + params payload owned by a staff user. When shared_flag is true,
// other staff in the same firm can see it (read-only).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, or } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { savedReports } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';

export interface SavedReportRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  reportKind: z.string().min(1).max(60),
  paramsJson: z.record(z.unknown()).default({}),
  shared: z.boolean().optional(),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  paramsJson: z.record(z.unknown()).optional(),
  shared: z.boolean().optional(),
});

export function createSavedReportsRouter(deps: SavedReportRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get(
    '/',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const kind = (req.query['kind'] ?? '').toString();
      const visible = or(
        eq(savedReports.ownerId, session.appUserId),
        eq(savedReports.sharedFlag, true),
      );
      const conds = [eq(savedReports.firmId, session.firmId), visible];
      if (kind) conds.push(eq(savedReports.reportKind, kind));
      const items = await deps.db
        .select()
        .from(savedReports)
        .where(and(...conds));
      res.json({ items });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'report:realization:read'),
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
      const [row] = await deps.db
        .insert(savedReports)
        .values({
          firmId: session.firmId,
          ownerId: session.appUserId,
          name: parsed.data.name,
          reportKind: parsed.data.reportKind,
          paramsJson: parsed.data.paramsJson,
          sharedFlag: parsed.data.shared ?? false,
        })
        .returning({ id: savedReports.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'report:realization:read'),
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
      if (parsed.data.paramsJson != null) patch['paramsJson'] = parsed.data.paramsJson;
      if (parsed.data.shared != null) patch['sharedFlag'] = parsed.data.shared;
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      patch['updatedAt'] = new Date();
      const updated = await deps.db
        .update(savedReports)
        .set(patch)
        .where(
          and(eq(savedReports.id, req.params['id']!), eq(savedReports.ownerId, session.appUserId)),
        )
        .returning({ id: savedReports.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found_or_not_owner' });
        return;
      }
      res.json({ ok: true });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const deleted = await deps.db
        .delete(savedReports)
        .where(
          and(eq(savedReports.id, req.params['id']!), eq(savedReports.ownerId, session.appUserId)),
        )
        .returning({ id: savedReports.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: 'not_found_or_not_owner' });
        return;
      }
      res.json({ ok: true });
    },
  );

  // GET by id (used by the run-loader to repopulate filters).
  router.get(
    '/:id',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ report: null });
        return;
      }
      const visible = or(
        eq(savedReports.ownerId, session.appUserId),
        eq(savedReports.sharedFlag, true),
      );
      const [row] = await deps.db
        .select()
        .from(savedReports)
        .where(
          and(
            eq(savedReports.firmId, session.firmId),
            eq(savedReports.id, req.params['id']!),
            visible,
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ report: row });
    },
  );

  return router;
}
