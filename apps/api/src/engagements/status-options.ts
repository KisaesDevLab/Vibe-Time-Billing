// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Staff-readable list of the firm's engagement progress statuses, for
// pickers (e.g. changing status while logging time). Distinct from the
// admin catalog endpoint (firm:settings:write) — this is read-only and
// gated on engagement:read so any timekeeper can populate a dropdown.

import express, { type Request, type Response, type Router } from 'express';
import { asc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { engagementStatusConfig } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface StatusOptionsRoutesDeps extends RbacDeps {
  db: Database | null;
}

export function createStatusOptionsRouter(deps: StatusOptionsRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({
          workflowState: engagementStatusConfig.workflowState,
          label: engagementStatusConfig.label,
          color: engagementStatusConfig.color,
          sortOrder: engagementStatusConfig.sortOrder,
          kanbanVisible: engagementStatusConfig.kanbanVisible,
        })
        .from(engagementStatusConfig)
        .where(eq(engagementStatusConfig.firmId, firmId))
        .orderBy(asc(engagementStatusConfig.sortOrder));
      res.json({ items });
    },
  );

  return router;
}
