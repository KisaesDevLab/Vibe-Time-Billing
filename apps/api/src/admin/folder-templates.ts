// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Folder-template CRUD (admin). v2 Part 1 — file manager.
// User-facing template list ships through /clients/:id/folder-templates;
// editing/creating new templates is admin-only and lives here.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientFolderTemplates } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface FolderTemplateRoutesDeps extends RbacDeps {
  db: Database | null;
}

const TreeNodeSchema: z.ZodType<{ name: string; children?: unknown[] }> = z.lazy(() =>
  z.object({
    name: z.string().min(1).max(200),
    children: z.array(TreeNodeSchema).optional(),
  }),
);

const FolderTemplateCreateSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(200),
  structureJson: z.array(TreeNodeSchema),
});

const FolderTemplatePatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  structureJson: z.array(TreeNodeSchema).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

export function createFolderTemplateRouter(deps: FolderTemplateRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(clientFolderTemplates)
        .where(eq(clientFolderTemplates.firmId, firmId));
      res.json({ items });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = FolderTemplateCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .insert(clientFolderTemplates)
        .values({
          firmId,
          key: parsed.data.key,
          name: parsed.data.name,
          structureJson: parsed.data.structureJson,
        })
        .returning({ id: clientFolderTemplates.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_folder_template',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { key: parsed.data.key, name: parsed.data.name },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = FolderTemplatePatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const id = req.params['id']!;
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.structureJson !== undefined)
        updates.structureJson = parsed.data.structureJson;
      if (parsed.data.status !== undefined) updates.status = parsed.data.status;
      await deps.db
        .update(clientFolderTemplates)
        .set(updates)
        .where(and(eq(clientFolderTemplates.id, id), eq(clientFolderTemplates.firmId, firmId)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_folder_template',
        entityId: id,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const id = req.params['id']!;
      // Soft archive — keep the template in case engagements reference it.
      await deps.db
        .update(clientFolderTemplates)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(and(eq(clientFolderTemplates.id, id), eq(clientFolderTemplates.firmId, firmId)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_folder_template',
        entityId: id,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
