// SPDX-License-Identifier: Elastic-2.0
//
// Staff-readable list of the firm's engagement progress statuses, for
// pickers (e.g. changing status while logging time). Distinct from the
// admin catalog endpoint (firm:settings:write) — this is read-only and
// gated on engagement:read so any timekeeper can populate a dropdown.

import express, { type Request, type Response, type Router } from 'express';
import { asc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { engagementStatusConfig, engagementStatusServiceLine } from '@vibe/db/schema';

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
      const [rows, mappings] = await Promise.all([
        deps.db
          .select({
            workflowState: engagementStatusConfig.workflowState,
            label: engagementStatusConfig.label,
            color: engagementStatusConfig.color,
            sortOrder: engagementStatusConfig.sortOrder,
            kanbanVisible: engagementStatusConfig.kanbanVisible,
          })
          .from(engagementStatusConfig)
          .where(eq(engagementStatusConfig.firmId, firmId))
          .orderBy(asc(engagementStatusConfig.sortOrder)),
        deps.db
          .select({
            workflowState: engagementStatusServiceLine.workflowState,
            serviceLineId: engagementStatusServiceLine.serviceLineId,
          })
          .from(engagementStatusServiceLine)
          .where(eq(engagementStatusServiceLine.firmId, firmId)),
      ]);
      // Group service-line ids by status. Empty array ⇒ unrestricted.
      const byState = new Map<string, string[]>();
      for (const m of mappings) {
        const list = byState.get(m.workflowState);
        if (list) list.push(m.serviceLineId);
        else byState.set(m.workflowState, [m.serviceLineId]);
      }
      const items = rows.map((r) => ({
        ...r,
        serviceLineIds: (byState.get(r.workflowState) ?? []).sort(),
      }));
      res.json({ items });
    },
  );

  return router;
}
