// SPDX-License-Identifier: Elastic-2.0
//
// Lightweight active-staff list for assignment pickers (requests, etc.).
// Any authenticated staff may list colleague names — assignment is a core
// staff function and names aren't sensitive. Returns { items: [{id, fullName}] }
// which the request UIs already expect. (This endpoint was referenced by the
// frontend but never existed, so assignee dropdowns came back empty.)

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers } from '@vibe/db/schema';

export interface FirmUsersDeps {
  db: Database | null;
}

export function createFirmUsersRouter(deps: FirmUsersDeps): Router {
  const router = express.Router();
  router.get('/', async (req: Request, res: Response) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ items: [] });
      return;
    }
    const rows = await deps.db
      .select({ id: appUsers.id, fullName: appUsers.fullName })
      .from(appUsers)
      .where(and(eq(appUsers.firmId, firmId), eq(appUsers.status, 'ACTIVE')))
      .orderBy(asc(appUsers.fullName));
    res.json({ items: rows });
  });
  return router;
}
