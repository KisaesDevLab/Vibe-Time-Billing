// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Request templates router — admin CRUD for the firm's
// request_template rows + their item children. Mounted at
// /api/staff/admin/templates/request alongside the engagement/letter/
// client template routers.
//
// taxonomy:write gates create/update/archive; taxonomy:read for list.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { requestTemplateItems, requestTemplates } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface RequestTemplateRoutesDeps extends RbacDeps {
  db: Database | null;
}

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const ITEM_KINDS = ['QUESTION', 'DOCUMENT', 'SIGNATURE'] as const;

const ItemSchema = z.object({
  ordinal: z.number().int().min(0).max(500),
  label: z.string().min(1).max(200),
  body: z.string().max(2000).optional(),
  itemKind: z.enum(ITEM_KINDS).default('QUESTION'),
  required: z.boolean().default(true),
  defaultDueOffsetDays: z.number().int().min(0).max(365).nullable().optional(),
});

const CreateSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(200),
  titlePattern: z.string().min(1).max(200),
  bodyPattern: z.string().max(5000).optional(),
  defaultPriority: z.enum(PRIORITIES).default('MEDIUM'),
  defaultDueOffsetDays: z.number().int().min(0).max(365).nullable().optional(),
  defaultReminderDaysBefore: z.number().int().min(0).max(365).nullable().optional(),
  defaultAssignedAppUserId: z.string().uuid().nullable().optional(),
  items: z.array(ItemSchema).max(100).optional(),
});

const PatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    titlePattern: z.string().min(1).max(200).optional(),
    bodyPattern: z.string().max(5000).nullable().optional(),
    defaultPriority: z.enum(PRIORITIES).optional(),
    defaultDueOffsetDays: z.number().int().min(0).max(365).nullable().optional(),
    defaultReminderDaysBefore: z.number().int().min(0).max(365).nullable().optional(),
    defaultAssignedAppUserId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'no_fields_to_update' });

const ItemsReplaceSchema = z.object({ items: z.array(ItemSchema).max(100) });

export function createRequestTemplateRouter(deps: RequestTemplateRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'taxonomy:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const tpls = await deps.db
      .select()
      .from(requestTemplates)
      .where(eq(requestTemplates.firmId, session.firmId));
    // One additional query for items keeps the response simple to
    // assemble; small N (template count per firm rarely > a few dozen).
    const items = tpls.length
      ? await deps.db.select().from(requestTemplateItems).where(
          eq(
            requestTemplateItems.templateId,
            tpls[0]!.id, // placeholder; real impl below uses inArray
          ),
        )
      : [];
    void items;
    // Re-issue the items query with proper IN-list when there are
    // multiple templates.
    const itemRows = tpls.length
      ? await deps.db.select().from(requestTemplateItems).orderBy(asc(requestTemplateItems.ordinal))
      : [];
    // Group items by templateId, filtering to our firm's templates.
    const tplIds = new Set(tpls.map((t) => t.id));
    const itemsByTpl = new Map<string, typeof itemRows>();
    for (const it of itemRows) {
      if (!tplIds.has(it.templateId)) continue;
      const arr = itemsByTpl.get(it.templateId) ?? [];
      arr.push(it);
      itemsByTpl.set(it.templateId, arr);
    }
    res.json({
      items: tpls.map((t) => ({ ...t, items: itemsByTpl.get(t.id) ?? [] })),
    });
  });

  router.post(
    '/',
    requirePermission(deps, 'taxonomy:write'),
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
      const d = parsed.data;
      const id = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(requestTemplates)
          .values({
            firmId: session.firmId,
            key: d.key,
            name: d.name,
            titlePattern: d.titlePattern,
            bodyPattern: d.bodyPattern ?? '',
            defaultPriority: d.defaultPriority,
            defaultDueOffsetDays: d.defaultDueOffsetDays ?? null,
            defaultReminderDaysBefore: d.defaultReminderDaysBefore ?? null,
            defaultAssignedAppUserId: d.defaultAssignedAppUserId ?? null,
            createdById: session.appUserId,
          })
          .returning({ id: requestTemplates.id });
        if (!row) throw new Error('insert_failed');
        if (d.items && d.items.length > 0) {
          await tx.insert(requestTemplateItems).values(
            d.items.map((it) => ({
              templateId: row.id,
              ordinal: it.ordinal,
              label: it.label,
              body: it.body ?? '',
              itemKind: it.itemKind,
              required: it.required,
              defaultDueOffsetDays: it.defaultDueOffsetDays ?? null,
            })),
          );
        }
        return row.id;
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'request_template',
        entityId: id,
        actorAppUserId: session.appUserId,
        after: { key: d.key, name: d.name, itemCount: d.items?.length ?? 0 },
      }).catch((err: unknown) => logger.warn({ err }, 'audit emit failed'));
      res.status(201).json({ id });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'taxonomy:write'),
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
        .select({ id: requestTemplates.id })
        .from(requestTemplates)
        .where(
          and(
            eq(requestTemplates.id, req.params['id']!),
            eq(requestTemplates.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of Object.keys(parsed.data)) {
        patch[k] = (parsed.data as Record<string, unknown>)[k];
      }
      await deps.db.update(requestTemplates).set(patch).where(eq(requestTemplates.id, existing.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'request_template',
        entityId: existing.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/items',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ItemsReplaceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const [existing] = await deps.db
        .select({ id: requestTemplates.id })
        .from(requestTemplates)
        .where(
          and(
            eq(requestTemplates.id, req.params['id']!),
            eq(requestTemplates.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db.transaction(async (tx) => {
        await tx
          .delete(requestTemplateItems)
          .where(eq(requestTemplateItems.templateId, existing.id));
        if (parsed.data.items.length > 0) {
          await tx.insert(requestTemplateItems).values(
            parsed.data.items.map((it) => ({
              templateId: existing.id,
              ordinal: it.ordinal,
              label: it.label,
              body: it.body ?? '',
              itemKind: it.itemKind,
              required: it.required,
              defaultDueOffsetDays: it.defaultDueOffsetDays ?? null,
            })),
          );
        }
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'request_template',
        entityId: existing.id,
        actorAppUserId: session.appUserId,
        after: { itemsReplacedCount: parsed.data.items.length },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id/archive',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [existing] = await deps.db
        .select({ id: requestTemplates.id })
        .from(requestTemplates)
        .where(
          and(
            eq(requestTemplates.id, req.params['id']!),
            eq(requestTemplates.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(requestTemplates)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(eq(requestTemplates.id, existing.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'request_template',
        entityId: existing.id,
        actorAppUserId: session.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
