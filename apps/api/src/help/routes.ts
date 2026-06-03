// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Support knowledge base — read + admin CRUD.
//
// Reads (categories, articles, single article, search) are open to any
// authenticated staff member; the router is mounted behind the
// /api/staff auth+CSRF gate so no extra permission is required. Writes
// (create/edit/archive articles + categories) require `kb:manage`.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { kbArticles, kbCategories } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { emitAudit } from '../auth/audit';
import { searchKbArticles } from './queries';

export interface HelpRoutesDeps extends RbacDeps {
  db: Database | null;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ArticleCreateSchema = z.object({
  slug: z.string().regex(SLUG_RE).max(120),
  title: z.string().min(1).max(200),
  summary: z.string().max(500).optional(),
  bodyMarkdown: z.string().min(1).max(50000),
  categorySlug: z.string().regex(SLUG_RE).max(120).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  sortOrder: z.number().int().optional(),
});

const ArticleUpdateSchema = ArticleCreateSchema.partial().omit({ slug: true });

const CategoryUpsertSchema = z.object({
  slug: z.string().regex(SLUG_RE).max(120),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  sortOrder: z.number().int().optional(),
});

export function createHelpRouter(deps: HelpRoutesDeps): Router {
  const router = express.Router();

  async function categoryIdForSlug(
    firmId: string,
    slug: string | null | undefined,
  ): Promise<string | null> {
    if (!deps.db || !slug) return null;
    const [row] = await deps.db
      .select({ id: kbCategories.id })
      .from(kbCategories)
      .where(and(eq(kbCategories.firmId, firmId), eq(kbCategories.slug, slug)))
      .limit(1);
    return row?.id ?? null;
  }

  // ---- Reads (any authenticated staff) --------------------------------

  // GET /categories — categories with published-article counts.
  router.get('/categories', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.json({ categories: [] });
      return;
    }
    const cats = await deps.db
      .select()
      .from(kbCategories)
      .where(eq(kbCategories.firmId, firmId))
      .orderBy(asc(kbCategories.sortOrder), asc(kbCategories.title));
    const counts = await deps.db
      .select({ categoryId: kbArticles.categoryId, n: sql<number>`count(*)::int` })
      .from(kbArticles)
      .where(and(eq(kbArticles.firmId, firmId), eq(kbArticles.status, 'PUBLISHED')))
      .groupBy(kbArticles.categoryId);
    const countBy = new Map(counts.map((c) => [c.categoryId, c.n]));
    res.json({
      categories: cats.map((c) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        description: c.description,
        sortOrder: c.sortOrder,
        articleCount: countBy.get(c.id) ?? 0,
      })),
    });
  });

  // GET /articles?category=&q= — PUBLISHED only (summaries, no body).
  router.get('/articles', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.json({ articles: [] });
      return;
    }
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
    if (q.trim()) {
      const hits = await searchKbArticles(deps.db, firmId, q, 25);
      res.json({
        articles: hits.map((h) => ({
          slug: h.slug,
          title: h.title,
          summary: h.summary,
          categoryId: h.categoryId,
        })),
      });
      return;
    }
    const categorySlug = typeof req.query['category'] === 'string' ? req.query['category'] : null;
    const categoryId = await categoryIdForSlug(firmId, categorySlug);
    const where = categorySlug
      ? and(
          eq(kbArticles.firmId, firmId),
          eq(kbArticles.status, 'PUBLISHED'),
          categoryId ? eq(kbArticles.categoryId, categoryId) : sql`false`,
        )
      : and(eq(kbArticles.firmId, firmId), eq(kbArticles.status, 'PUBLISHED'));
    const rows = await deps.db
      .select({
        slug: kbArticles.slug,
        title: kbArticles.title,
        summary: kbArticles.summary,
        categoryId: kbArticles.categoryId,
        sortOrder: kbArticles.sortOrder,
      })
      .from(kbArticles)
      .where(where)
      .orderBy(asc(kbArticles.sortOrder), asc(kbArticles.title));
    res.json({ articles: rows });
  });

  // GET /articles/:slug — single PUBLISHED article (full body).
  router.get('/articles/:slug', async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const [row] = await deps.db
      .select()
      .from(kbArticles)
      .where(and(eq(kbArticles.firmId, firmId), eq(kbArticles.slug, req.params.slug!)))
      .limit(1);
    if (!row || row.status === 'ARCHIVED') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      article: {
        id: row.id,
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        bodyMarkdown: row.bodyMarkdown,
        categoryId: row.categoryId,
        tags: row.tags ?? [],
        status: row.status,
        updatedAt: row.updatedAt,
      },
    });
  });

  // ---- Management (kb:manage) -----------------------------------------

  // GET /manage/articles — all statuses, for the admin editor.
  router.get(
    '/manage/articles',
    requirePermission(deps, 'kb:manage'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ articles: [] });
        return;
      }
      const rows = await deps.db
        .select({
          id: kbArticles.id,
          slug: kbArticles.slug,
          title: kbArticles.title,
          summary: kbArticles.summary,
          categoryId: kbArticles.categoryId,
          status: kbArticles.status,
          isSystem: kbArticles.isSystem,
          sortOrder: kbArticles.sortOrder,
          updatedAt: kbArticles.updatedAt,
        })
        .from(kbArticles)
        .where(eq(kbArticles.firmId, firmId))
        .orderBy(asc(kbArticles.sortOrder), asc(kbArticles.title));
      res.json({ articles: rows });
    },
  );

  router.post(
    '/categories',
    requirePermission(deps, 'kb:manage'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = CategoryUpsertSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const d = parsed.data;
      await deps.db
        .insert(kbCategories)
        .values({
          firmId,
          slug: d.slug,
          title: d.title,
          description: d.description,
          sortOrder: d.sortOrder ?? 0,
        })
        .onConflictDoUpdate({
          target: [kbCategories.firmId, kbCategories.slug],
          set: {
            title: d.title,
            description: d.description,
            sortOrder: d.sortOrder ?? 0,
            updatedAt: new Date(),
          },
        });
      res.json({ ok: true });
    },
  );

  router.post(
    '/articles',
    requirePermission(deps, 'kb:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ArticleCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const d = parsed.data;
      const categoryId = await categoryIdForSlug(session.firmId, d.categorySlug);
      try {
        const [row] = await deps.db
          .insert(kbArticles)
          .values({
            firmId: session.firmId,
            categoryId,
            slug: d.slug,
            title: d.title,
            summary: d.summary,
            bodyMarkdown: d.bodyMarkdown,
            tags: d.tags ?? null,
            status: d.status ?? 'PUBLISHED',
            isSystem: false,
            sortOrder: d.sortOrder ?? 0,
            updatedById: session.appUserId,
          })
          .returning({ id: kbArticles.id });
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'kb_article',
          entityId: row!.id,
          actorAppUserId: session.appUserId,
          after: { slug: d.slug, title: d.title, status: d.status ?? 'PUBLISHED' },
        }).catch(() => undefined);
        res.json({ ok: true, id: row!.id });
      } catch {
        res.status(409).json({ error: 'slug_conflict' });
      }
    },
  );

  router.patch(
    '/articles/:id',
    requirePermission(deps, 'kb:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ArticleUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const d = parsed.data;
      const set: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedById: session.appUserId,
      };
      if (d.title !== undefined) set['title'] = d.title;
      if (d.summary !== undefined) set['summary'] = d.summary;
      if (d.bodyMarkdown !== undefined) set['bodyMarkdown'] = d.bodyMarkdown;
      if (d.tags !== undefined) set['tags'] = d.tags;
      if (d.status !== undefined) set['status'] = d.status;
      if (d.sortOrder !== undefined) set['sortOrder'] = d.sortOrder;
      if (d.categorySlug !== undefined) {
        set['categoryId'] = await categoryIdForSlug(session.firmId, d.categorySlug);
      }
      const rows = await deps.db
        .update(kbArticles)
        .set(set)
        .where(and(eq(kbArticles.firmId, session.firmId), eq(kbArticles.id, req.params.id!)))
        .returning({ id: kbArticles.id });
      if (rows.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'kb_article',
        entityId: req.params.id!,
        actorAppUserId: session.appUserId,
        after: set,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.post(
    '/articles/:id/archive',
    requirePermission(deps, 'kb:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const rows = await deps.db
        .update(kbArticles)
        .set({ status: 'ARCHIVED', updatedAt: new Date(), updatedById: session.appUserId })
        .where(and(eq(kbArticles.firmId, session.firmId), eq(kbArticles.id, req.params.id!)))
        .returning({ id: kbArticles.id });
      if (rows.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'kb_article',
        entityId: req.params.id!,
        actorAppUserId: session.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
