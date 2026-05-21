// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Engagement template starter-pack reader (Q24). Returns the JSON
// shipped at `/seed/engagement-templates.json` so the admin UI can
// preview the pack before installing.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export type TemplatePackDeps = RbacDeps;

let cached: unknown = null;

async function load(): Promise<unknown> {
  if (cached) return cached;
  const candidates = [
    path.resolve(process.cwd(), 'seed/engagement-templates.json'),
    path.resolve(process.cwd(), '../../seed/engagement-templates.json'),
  ];
  for (const c of candidates) {
    try {
      const raw = await readFile(c, 'utf8');
      cached = JSON.parse(raw);
      return cached;
    } catch {
      // try next
    }
  }
  return { templates: [], note: 'seed file not found from cwd' };
}

export function createTemplatePackRouter(deps: TemplatePackDeps): Router {
  const router = express.Router();

  router.get(
    '/engagement-template-pack',
    requirePermission(deps, 'taxonomy:read'),
    async (_req: Request, res: Response) => {
      const data = await load();
      res.json(data);
    },
  );

  return router;
}
