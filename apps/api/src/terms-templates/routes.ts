// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P07 — Terms templates staff API (ADDENDUM-PROPOSAL-MODULE.md §P07).
//
// Mounted at /api/staff/terms-templates. Reuses `service:read|write`
// since terms live in the same authoring surface as services and
// packages.
//
// Endpoints:
//   GET    /                — list (?category=, ?includeArchived=)
//   GET    /:id             — detail
//   POST   /                — create (version=1)
//   PATCH  /:id             — update; version bumps automatically
//   POST   /:id/archive
//   POST   /:id/restore
//   POST   /:id/make-default — set as default for its category
//                              (clears prior default in same category)
//   POST   /seed-starters    — install the 6 starter templates for
//                              this firm; idempotent on (firm, name).
//   POST   /:id/preview      — POST { context } → render content_md
//                              with merge tokens resolved; returns
//                              { output, unresolvedTokens }

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { termsTemplates } from '@vibe/db/schema';
import {
  resolveMergeTokens,
  STARTER_TERMS_TEMPLATES,
  type MergeContext,
} from '@vibe/core/proposals';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface TermsTemplateRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CATEGORIES = ['TAX', 'BOOKKEEPING', 'AUDIT', 'ADVISORY', 'PAYROLL', 'CFO'] as const;

const CreateSchema = z.object({
  category: z.enum(CATEGORIES),
  name: z.string().min(1).max(240),
  contentMd: z.string().max(200_000).optional(),
  isDefault: z.boolean().optional(),
});

const PatchSchema = z.object({
  category: z.enum(CATEGORIES).optional(),
  name: z.string().min(1).max(240).optional(),
  contentMd: z.string().max(200_000).optional(),
});

const PreviewSchema = z.object({
  context: z.record(z.unknown()),
});

export function createTermsTemplateRouter(deps: TermsTemplateRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'service:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const conds = [eq(termsTemplates.firmId, session.firmId)];
    const category = typeof req.query['category'] === 'string' ? req.query['category'] : null;
    if (category && (CATEGORIES as readonly string[]).includes(category)) {
      conds.push(eq(termsTemplates.category, category as (typeof CATEGORIES)[number]));
    }
    if (req.query['includeArchived'] !== 'true') {
      conds.push(isNull(termsTemplates.archivedAt));
    }
    const items = await deps.db
      .select()
      .from(termsTemplates)
      .where(and(...conds))
      .orderBy(asc(termsTemplates.category), asc(termsTemplates.name));
    res.json({ items });
  });

  router.get(
    '/:id',
    requirePermission(deps, 'service:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(termsTemplates)
        .where(
          and(eq(termsTemplates.id, req.params['id']!), eq(termsTemplates.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ template: row });
    },
  );

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
      // If asked to be default, clear the prior default first.
      if (parsed.data.isDefault) {
        await deps.db
          .update(termsTemplates)
          .set({ isDefault: false })
          .where(
            and(
              eq(termsTemplates.firmId, session.firmId),
              eq(termsTemplates.category, parsed.data.category),
              eq(termsTemplates.isDefault, true),
              isNull(termsTemplates.archivedAt),
            ),
          );
      }
      const [row] = await deps.db
        .insert(termsTemplates)
        .values({
          firmId: session.firmId,
          category: parsed.data.category,
          name: parsed.data.name,
          contentMd: parsed.data.contentMd ?? '',
          version: 1,
          isDefault: parsed.data.isDefault ?? false,
          createdById: session.appUserId,
        })
        .returning({ id: termsTemplates.id });
      if (!row) throw new Error('terms_template_insert_failed');
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'terms_template',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: {
          category: parsed.data.category,
          name: parsed.data.name,
          isDefault: parsed.data.isDefault ?? false,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row.id });
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
        .from(termsTemplates)
        .where(
          and(eq(termsTemplates.id, req.params['id']!), eq(termsTemplates.firmId, session.firmId)),
        )
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const patch: Record<string, unknown> = {
        updatedAt: new Date(),
        version: prior.version + 1,
      };
      if (parsed.data.category != null) patch['category'] = parsed.data.category;
      if (parsed.data.name != null) patch['name'] = parsed.data.name;
      if (parsed.data.contentMd != null) patch['contentMd'] = parsed.data.contentMd;
      await deps.db.update(termsTemplates).set(patch).where(eq(termsTemplates.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'terms_template',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: { version: prior.version },
        after: { version: prior.version + 1, ...patch },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, version: prior.version + 1 });
    },
  );

  router.post(
    '/:id/archive',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(termsTemplates)
        .where(
          and(eq(termsTemplates.id, req.params['id']!), eq(termsTemplates.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.archivedAt != null) {
        res.json({ ok: true, alreadyArchived: true });
        return;
      }
      const now = new Date();
      await deps.db
        .update(termsTemplates)
        .set({ archivedAt: now, isDefault: false, updatedAt: now })
        .where(eq(termsTemplates.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'terms_template',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { archivedAt: null },
        after: { archivedAt: now.toISOString(), isDefault: false },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/restore',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(termsTemplates)
        .where(
          and(eq(termsTemplates.id, req.params['id']!), eq(termsTemplates.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.archivedAt == null) {
        res.json({ ok: true, alreadyActive: true });
        return;
      }
      await deps.db
        .update(termsTemplates)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(eq(termsTemplates.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'terms_template',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { archivedAt: row.archivedAt?.toISOString() ?? null },
        after: { archivedAt: null },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/make-default',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(termsTemplates)
        .where(
          and(eq(termsTemplates.id, req.params['id']!), eq(termsTemplates.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.archivedAt != null) {
        res.status(409).json({ error: 'archived_template' });
        return;
      }
      // Clear prior default in same category (partial unique index
      // enforces only one default per (firm, category) for active rows).
      await deps.db
        .update(termsTemplates)
        .set({ isDefault: false })
        .where(
          and(
            eq(termsTemplates.firmId, session.firmId),
            eq(termsTemplates.category, row.category),
            eq(termsTemplates.isDefault, true),
            isNull(termsTemplates.archivedAt),
          ),
        );
      await deps.db
        .update(termsTemplates)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(termsTemplates.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'terms_template',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { isDefault: row.isDefault },
        after: { isDefault: true },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/seed-starters',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      // Idempotent: don't double-insert if a template already exists
      // for this firm with the same name.
      const existing = await deps.db
        .select({ name: termsTemplates.name })
        .from(termsTemplates)
        .where(eq(termsTemplates.firmId, session.firmId));
      const existingNames = new Set(existing.map((r) => r.name));
      const toInsert = STARTER_TERMS_TEMPLATES.filter((t) => !existingNames.has(t.name));
      if (toInsert.length === 0) {
        res.json({ ok: true, inserted: 0, skipped: STARTER_TERMS_TEMPLATES.length });
        return;
      }
      // Only mark as default if no default exists for that category.
      const existingDefaults = await deps.db
        .select({ category: termsTemplates.category })
        .from(termsTemplates)
        .where(
          and(
            eq(termsTemplates.firmId, session.firmId),
            eq(termsTemplates.isDefault, true),
            isNull(termsTemplates.archivedAt),
          ),
        );
      const haveDefault = new Set(existingDefaults.map((r) => r.category));
      await deps.db.insert(termsTemplates).values(
        toInsert.map((t) => ({
          firmId: session.firmId,
          category: t.category,
          name: t.name,
          contentMd: t.contentMd,
          version: 1,
          isDefault: !haveDefault.has(t.category),
          createdById: session.appUserId,
        })),
      );
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'terms_template.starters',
        entityId: session.firmId,
        actorAppUserId: session.appUserId,
        after: { inserted: toInsert.length, skipped: existingNames.size },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({
        ok: true,
        inserted: toInsert.length,
        skipped: STARTER_TERMS_TEMPLATES.length - toInsert.length,
      });
    },
  );

  router.post(
    '/:id/preview',
    requirePermission(deps, 'service:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = PreviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(termsTemplates)
        .where(
          and(eq(termsTemplates.id, req.params['id']!), eq(termsTemplates.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const result = resolveMergeTokens(row.contentMd, parsed.data.context as MergeContext);
      res.json({
        output: result.output,
        unresolvedTokens: result.unresolvedTokens,
        version: row.version,
      });
    },
  );

  return router;
}
