// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P02 — Service tags staff API (ADDENDUM-PROPOSAL-MODULE.md §P02).
//
// Mounted at /api/staff/service-tags.
//   GET    /         — list (firm-scoped)
//   POST   /         — create
//   PATCH  /:id      — rename / recolor
//   DELETE /:id      — drop (CASCADE removes assignments)
//
// Name uniqueness is case-insensitive per firm. Migration enforces
// it via `UNIQUE (firm_id, lower(name))`.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { serviceTags } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface ServiceTagRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});

export function createServiceTagRouter(deps: ServiceTagRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'service:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select()
      .from(serviceTags)
      .where(eq(serviceTags.firmId, session.firmId))
      .orderBy(asc(serviceTags.name));
    res.json({ items });
  });

  router.post(
    '/',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      try {
        const [row] = await deps.db
          .insert(serviceTags)
          .values({
            firmId: session.firmId,
            name: parsed.data.name,
            color: parsed.data.color ?? null,
          })
          .returning({ id: serviceTags.id });
        if (!row) throw new Error('service_tag_insert_failed');
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'service_tag',
          entityId: row.id,
          actorAppUserId: session.appUserId,
          after: { name: parsed.data.name, color: parsed.data.color ?? null },
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.status(201).json({ id: row.id });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (/firm_name_uk|unique/i.test(message)) {
          res.status(409).json({ error: 'tag_name_taken' });
          return;
        }
        throw err;
      }
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(serviceTags)
        .where(and(eq(serviceTags.id, req.params['id']!), eq(serviceTags.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (parsed.data.name != null) patch['name'] = parsed.data.name;
      if (parsed.data.color !== undefined) patch['color'] = parsed.data.color;
      if (Object.keys(patch).length === 0) {
        res.json({ ok: true });
        return;
      }
      try {
        await deps.db.update(serviceTags).set(patch).where(eq(serviceTags.id, prior.id));
        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'service_tag',
          entityId: prior.id,
          actorAppUserId: session.appUserId,
          before: prior,
          after: patch,
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.json({ ok: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (/firm_name_uk|unique/i.test(message)) {
          res.status(409).json({ error: 'tag_name_taken' });
          return;
        }
        throw err;
      }
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(serviceTags)
        .where(and(eq(serviceTags.id, req.params['id']!), eq(serviceTags.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db.delete(serviceTags).where(eq(serviceTags.id, prior.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'service_tag',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: prior,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}
