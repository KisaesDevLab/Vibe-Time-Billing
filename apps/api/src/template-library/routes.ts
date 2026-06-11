// SPDX-License-Identifier: Elastic-2.0
//
// Template library import API. Per-area endpoints let an admin seed the firm's
// own catalog with the shipped system defaults:
//   GET  /api/staff/template-library/:area          — list shipped items + imported flag
//   POST /api/staff/template-library/:area/import   — clone selected (or all) into the firm
// area ∈ services | packages | terms | emails | engagements | letters |
// requests | clients. Services/packages/terms are gated service:read/write;
// emails + engagement/letter/request/client templates are taxonomy:read/write.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';

import type { Database } from '@vibe/db';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import {
  importClients,
  importEmails,
  importEngagements,
  importLetters,
  importPackages,
  importRequests,
  importServices,
  importTerms,
  listLibrary,
  type Area,
  type ImportCounts,
} from './clone';

export interface TemplateLibraryRoutesDeps extends RbacDeps {
  db: Database | null;
}

const ImportSchema = z.object({
  slugs: z.array(z.string().min(1).max(120)).max(500).optional(),
});

export function createTemplateLibraryRouter(deps: TemplateLibraryRoutesDeps): Router {
  const router = express.Router();

  function list(area: Area) {
    return async (req: Request, res: Response): Promise<void> => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await listLibrary(deps.db, firmId, area);
      res.json({ items });
    };
  }

  function runImport(area: Area) {
    return async (req: Request, res: Response): Promise<void> => {
      const parsed = ImportSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      const appUserId = req.staffSession!.appUserId;
      if (!deps.db) {
        res.json({ imported: 0, skipped: 0, total: 0 });
        return;
      }
      const slugs = parsed.data.slugs;
      const counts: ImportCounts = await deps.db.transaction(async (tx) => {
        const t = tx as unknown as Database;
        switch (area) {
          case 'services':
            return importServices(t, { firmId, appUserId, slugs });
          case 'terms':
            return importTerms(t, { firmId, appUserId, slugs });
          case 'packages':
            return importPackages(t, { firmId, appUserId, slugs });
          case 'emails':
            return importEmails(t, { firmId, slugs });
          case 'engagements':
            return importEngagements(t, { firmId, appUserId, slugs });
          case 'letters':
            return importLetters(t, { firmId, appUserId, slugs });
          case 'requests':
            return importRequests(t, { firmId, appUserId, slugs });
          case 'clients':
            return importClients(t, { firmId, appUserId, slugs });
        }
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'template_import',
        entityId: null,
        actorAppUserId: appUserId,
        after: { area, imported: counts.imported, skipped: counts.skipped },
      }).catch(() => undefined);
      res.json(counts);
    };
  }

  // service:* gated areas
  for (const area of ['services', 'packages', 'terms'] as const) {
    router.get(`/${area}`, requirePermission(deps, 'service:read'), list(area));
    router.post(`/${area}/import`, requirePermission(deps, 'service:write'), runImport(area));
  }
  // emails live in notification_template → taxonomy permission
  router.get('/emails', requirePermission(deps, 'taxonomy:read'), list('emails'));
  router.post('/emails/import', requirePermission(deps, 'taxonomy:write'), runImport('emails'));

  // engagement / letter / request / client templates → taxonomy permission
  for (const area of ['engagements', 'letters', 'requests', 'clients'] as const) {
    router.get(`/${area}`, requirePermission(deps, 'taxonomy:read'), list(area));
    router.post(`/${area}/import`, requirePermission(deps, 'taxonomy:write'), runImport(area));
  }

  return router;
}
