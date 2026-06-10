// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin CRUD for client folder-structure templates + per-client assignment.
// Templates/items are firm config (firm:settings:write); assigning a template
// to a client is folder management (storage:folder:edit). Mounted at
// /api/staff/admin/folder-templates.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clientFolderTemplateItems, clientFolderTemplates, clients } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { seedDefaultFolderTemplate } from './folder-templates';

export interface FolderTemplateDeps extends RbacDeps {
  db: Database | null;
}

const ItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  visibility: z.enum(['private', 'client_visible']).nullable().default(null),
  sortOrder: z.number().int().nonnegative().optional(),
  enabled: z.boolean().optional(),
});

export function createFolderTemplateRouter(deps: FolderTemplateDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['id', 'itemId', 'clientId']);

  // List templates (+ items), auto-seeding the firm default on first read.
  router.get(
    '/',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ templates: [] });
        return;
      }
      await seedDefaultFolderTemplate(deps.db, firmId).catch(() => undefined);
      const templates = await deps.db
        .select()
        .from(clientFolderTemplates)
        .where(eq(clientFolderTemplates.firmId, firmId))
        .orderBy(asc(clientFolderTemplates.name));
      const items = await deps.db
        .select()
        .from(clientFolderTemplateItems)
        .orderBy(asc(clientFolderTemplateItems.sortOrder));
      const byTemplate = new Map<string, typeof items>();
      for (const it of items) {
        const list = byTemplate.get(it.templateId) ?? [];
        list.push(it);
        byTemplate.set(it.templateId, list);
      }
      res.json({
        templates: templates.map((t) => ({ ...t, items: byTemplate.get(t.id) ?? [] })),
      });
    },
  );

  // Create a template.
  router.post(
    '/',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      const [row] = await deps.db
        .insert(clientFolderTemplates)
        .values({ firmId, name: parsed.data.name, isDefault: false })
        .returning();
      res.json({ template: { ...row, items: [] } });
    },
  );

  // Rename / set-default a template. Setting default clears the prior default
  // (the partial unique index allows only one).
  router.patch(
    '/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          isDefault: z.literal(true).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      const id = req.params['id']!;
      await deps.db.transaction(async (tx) => {
        const [owned] = await tx
          .select({ id: clientFolderTemplates.id })
          .from(clientFolderTemplates)
          .where(and(eq(clientFolderTemplates.id, id), eq(clientFolderTemplates.firmId, firmId)))
          .limit(1);
        if (!owned) return;
        if (parsed.data.isDefault) {
          await tx
            .update(clientFolderTemplates)
            .set({ isDefault: false })
            .where(eq(clientFolderTemplates.firmId, firmId));
        }
        await tx
          .update(clientFolderTemplates)
          .set({
            ...(parsed.data.name ? { name: parsed.data.name } : {}),
            ...(parsed.data.isDefault ? { isDefault: true } : {}),
          })
          .where(eq(clientFolderTemplates.id, id));
      });
      res.json({ ok: true });
    },
  );

  // Delete a template (not the default — a firm always keeps one).
  router.delete(
    '/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({ isDefault: clientFolderTemplates.isDefault })
        .from(clientFolderTemplates)
        .where(
          and(
            eq(clientFolderTemplates.id, req.params['id']!),
            eq(clientFolderTemplates.firmId, firmId),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.isDefault) {
        res.status(409).json({ error: 'cannot_delete_default' });
        return;
      }
      await deps.db
        .delete(clientFolderTemplates)
        .where(
          and(
            eq(clientFolderTemplates.id, req.params['id']!),
            eq(clientFolderTemplates.firmId, firmId),
          ),
        );
      res.json({ ok: true });
    },
  );

  // Add an item to a template.
  router.post(
    '/:id/items',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ItemSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      const [tmpl] = await deps.db
        .select({ id: clientFolderTemplates.id })
        .from(clientFolderTemplates)
        .where(
          and(
            eq(clientFolderTemplates.id, req.params['id']!),
            eq(clientFolderTemplates.firmId, firmId),
          ),
        )
        .limit(1);
      if (!tmpl) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(clientFolderTemplateItems)
        .values({
          templateId: tmpl.id,
          name: parsed.data.name,
          visibility: parsed.data.visibility,
          sortOrder: parsed.data.sortOrder ?? 0,
        })
        .returning();
      res.json({ item: row });
    },
  );

  // Update an item (firm-scoped via its template).
  router.patch(
    '/items/:itemId',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ItemSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      // Ownership: the item's template must belong to the firm.
      const [own] = await deps.db
        .select({ id: clientFolderTemplateItems.id })
        .from(clientFolderTemplateItems)
        .innerJoin(
          clientFolderTemplates,
          eq(clientFolderTemplates.id, clientFolderTemplateItems.templateId),
        )
        .where(
          and(
            eq(clientFolderTemplateItems.id, req.params['itemId']!),
            eq(clientFolderTemplates.firmId, firmId),
          ),
        )
        .limit(1);
      if (!own) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(clientFolderTemplateItems)
        .set(parsed.data)
        .where(eq(clientFolderTemplateItems.id, req.params['itemId']!));
      res.json({ ok: true });
    },
  );

  router.delete(
    '/items/:itemId',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [own] = await deps.db
        .select({ id: clientFolderTemplateItems.id })
        .from(clientFolderTemplateItems)
        .innerJoin(
          clientFolderTemplates,
          eq(clientFolderTemplates.id, clientFolderTemplateItems.templateId),
        )
        .where(
          and(
            eq(clientFolderTemplateItems.id, req.params['itemId']!),
            eq(clientFolderTemplates.firmId, firmId),
          ),
        )
        .limit(1);
      if (!own) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .delete(clientFolderTemplateItems)
        .where(eq(clientFolderTemplateItems.id, req.params['itemId']!));
      res.json({ ok: true });
    },
  );

  // Reorder a template's items: [{ id, sortOrder }].
  router.post(
    '/:id/items/reorder',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = z
        .object({
          order: z.array(z.object({ id: z.string().uuid(), sortOrder: z.number().int() })),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      const [tmpl] = await deps.db
        .select({ id: clientFolderTemplates.id })
        .from(clientFolderTemplates)
        .where(
          and(
            eq(clientFolderTemplates.id, req.params['id']!),
            eq(clientFolderTemplates.firmId, firmId),
          ),
        )
        .limit(1);
      if (!tmpl) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db.transaction(async (tx) => {
        for (const o of parsed.data.order) {
          await tx
            .update(clientFolderTemplateItems)
            .set({ sortOrder: o.sortOrder })
            .where(
              and(
                eq(clientFolderTemplateItems.id, o.id),
                eq(clientFolderTemplateItems.templateId, tmpl.id),
              ),
            );
        }
      });
      res.json({ ok: true });
    },
  );

  // Assign a template to a client (NULL → firm default). Folder management.
  router.put(
    '/assign/:clientId',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = z.object({ templateId: z.string().uuid().nullable() }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid' });
        return;
      }
      if (parsed.data.templateId) {
        const [ok] = await deps.db
          .select({ id: clientFolderTemplates.id })
          .from(clientFolderTemplates)
          .where(
            and(
              eq(clientFolderTemplates.id, parsed.data.templateId),
              eq(clientFolderTemplates.firmId, firmId),
            ),
          )
          .limit(1);
        if (!ok) {
          res.status(400).json({ error: 'unknown_template' });
          return;
        }
      }
      const [row] = await deps.db
        .update(clients)
        .set({ folderTemplateId: parsed.data.templateId })
        .where(and(eq(clients.id, req.params['clientId']!), eq(clients.firmId, firmId)))
        .returning({ id: clients.id });
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ ok: true });
    },
  );

  return router;
}
