// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Portal-realm help center (read-only). Mounted at /api/portal/help under
// portal auth. Surfaces ONLY client-visible PUBLISHED articles (audience
// client/both) so internal staff content never reaches a client. Mirrors
// the staff /api/staff/help read endpoints, audience-filtered.

import express, { type Request, type Response, type Router } from 'express';

import type { Database } from '@vibe/db';

import {
  PORTAL_AUDIENCES,
  getKbArticleForAudience,
  listKbArticlesForAudience,
  listKbCategoriesForAudience,
} from './queries';

export interface PortalHelpDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

export function createPortalHelpRouter(deps: PortalHelpDeps): Router {
  const router = express.Router();

  // GET /categories — categories with at least one client-visible article.
  router.get('/categories', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const categories = await listKbCategoriesForAudience(deps.db, session.firmId, PORTAL_AUDIENCES);
    res.json({ categories });
  });

  // GET /articles?category=<slug>&q=<query> — client-visible summaries.
  router.get('/articles', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const categorySlug =
      typeof req.query['category'] === 'string' ? req.query['category'] : undefined;
    const query = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
    const articles = await listKbArticlesForAudience(deps.db, session.firmId, PORTAL_AUDIENCES, {
      categorySlug,
      query,
    });
    res.json({ articles });
  });

  // GET /articles/:slug — a single client-visible article (full body).
  router.get('/articles/:slug', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const article = await getKbArticleForAudience(
      deps.db,
      session.firmId,
      req.params['slug']!,
      PORTAL_AUDIENCES,
    );
    if (!article) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ article });
  });

  return router;
}
