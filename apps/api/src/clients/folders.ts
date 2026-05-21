// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Folder CRUD + folder-template instantiation for the v2 file manager.
// Mounted on the client router at /clients/:id/folders.

import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { type Request, type Response, type Router } from 'express';

import type { Database } from '@vibe/db';
import { clientFolderTemplates, clientFolders, clients, clientFiles } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface FolderRoutesDeps extends RbacDeps {
  db: Database | null;
}

const FolderCreateSchema = z.object({
  name: z.string().min(1).max(200),
  parentFolderId: z.string().uuid().nullable().optional(),
});

const FolderPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  parentFolderId: z.string().uuid().nullable().optional(),
});

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

interface TreeNode {
  name: string;
  children?: TreeNode[];
}

async function spawnTree(
  tx: Database,
  firmId: string,
  clientId: string,
  parentFolderId: string | null,
  nodes: TreeNode[],
  createdById: string | null,
): Promise<string[]> {
  const created: string[] = [];
  for (const n of nodes) {
    const [row] = await tx
      .insert(clientFolders)
      .values({
        firmId,
        clientId,
        parentFolderId,
        name: n.name,
        createdById,
      })
      .returning({ id: clientFolders.id });
    if (row?.id) {
      created.push(row.id);
      if (n.children && n.children.length > 0) {
        const sub = await spawnTree(tx, firmId, clientId, row.id, n.children, createdById);
        created.push(...sub);
      }
    }
  }
  return created;
}

export function mountFolderRoutes(router: Router, deps: FolderRoutesDeps): void {
  router.get(
    '/:id/folders',
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
        .from(clientFolders)
        .where(eq(clientFolders.clientId, clientId));
      res.json({ items });
    },
  );

  router.post(
    '/:id/folders',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = FolderCreateSchema.safeParse(req.body);
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
      const [row] = await deps.db
        .insert(clientFolders)
        .values({
          firmId,
          clientId,
          parentFolderId: parsed.data.parentFolderId ?? null,
          name: parsed.data.name,
          createdById: req.staffSession!.appUserId,
        })
        .returning({ id: clientFolders.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_folder',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { clientId, name: parsed.data.name },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/:id/folders/:folderId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = FolderPatchSchema.safeParse(req.body);
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
      const folderId = req.params['folderId']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.parentFolderId !== undefined)
        updates.parentFolderId = parsed.data.parentFolderId;
      await deps.db
        .update(clientFolders)
        .set(updates)
        .where(and(eq(clientFolders.id, folderId), eq(clientFolders.clientId, clientId)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_folder',
        entityId: folderId,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.delete(
    '/:id/folders/:folderId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const clientId = req.params['id']!;
      const folderId = req.params['folderId']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Refuse if contains any file or child folder.
      const [fileCount] = await deps.db
        .select({ c: sql<number>`COUNT(*)` })
        .from(clientFiles)
        .where(eq(clientFiles.folderId, folderId));
      const [childCount] = await deps.db
        .select({ c: sql<number>`COUNT(*)` })
        .from(clientFolders)
        .where(eq(clientFolders.parentFolderId, folderId));
      if (Number(fileCount?.c ?? 0) > 0 || Number(childCount?.c ?? 0) > 0) {
        res.status(409).json({
          error: 'not_empty',
          files: Number(fileCount?.c ?? 0),
          children: Number(childCount?.c ?? 0),
        });
        return;
      }
      await deps.db
        .delete(clientFolders)
        .where(and(eq(clientFolders.id, folderId), eq(clientFolders.clientId, clientId)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_folder',
        entityId: folderId,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/folders/from-template',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { templateId?: string; parentFolderId?: string | null };
      const templateId = typeof body.templateId === 'string' ? body.templateId : '';
      if (!templateId) {
        res.status(400).json({ error: 'templateId_required' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true, created: 0 });
        return;
      }
      const clientId = req.params['id']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [tpl] = await deps.db
        .select()
        .from(clientFolderTemplates)
        .where(
          and(eq(clientFolderTemplates.id, templateId), eq(clientFolderTemplates.firmId, firmId)),
        )
        .limit(1);
      if (!tpl) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }
      const nodes = Array.isArray(tpl.structureJson)
        ? (tpl.structureJson as unknown as TreeNode[])
        : [];
      const createdIds = await deps.db.transaction(async (tx) =>
        spawnTree(
          tx as unknown as Database,
          firmId,
          clientId,
          body.parentFolderId ?? null,
          nodes,
          req.staffSession!.appUserId,
        ),
      );
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_folder',
        entityId: null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { fromTemplate: templateId, createdCount: createdIds.length },
      }).catch(() => undefined);
      res.json({ ok: true, created: createdIds.length, ids: createdIds });
    },
  );

  // Folder-template list (read-only — picker uses it). Path includes the
  // client :id so the route nests cleanly under the client-scoped router;
  // the templates themselves are firm-scoped (the :id is only used for
  // firm-membership validation).
  router.get(
    '/:id/folder-templates',
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
        .from(clientFolderTemplates)
        .where(
          and(eq(clientFolderTemplates.firmId, firmId), eq(clientFolderTemplates.status, 'ACTIVE')),
        );
      res.json({ items });
    },
  );
}
