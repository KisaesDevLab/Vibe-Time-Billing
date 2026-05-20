// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Audit-log viewer (Phase 19). Read-only; the audit_log table is
// append-only at the DB role level.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { auditLog } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface AuditRoutesDeps extends RbacDeps {
  db: Database | null;
}

const QuerySchema = z.object({
  entityType: z.string().max(40).optional(),
  entityId: z.string().uuid().optional(),
  actorAppUserId: z.string().uuid().optional(),
  actorPortalIdentityId: z.string().uuid().optional(),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/)
    .optional(),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function createAuditRouter(deps: AuditRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'admin:audit:read'),
    async (req: Request, res: Response) => {
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_query' });
        return;
      }
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const conds: SQL<unknown>[] = [];
      const q = parsed.data;
      if (q.entityType) conds.push(eq(auditLog.entityType, q.entityType));
      if (q.entityId) conds.push(eq(auditLog.entityId, q.entityId));
      if (q.actorAppUserId) conds.push(eq(auditLog.actorAppUserId, q.actorAppUserId));
      if (q.actorPortalIdentityId)
        conds.push(eq(auditLog.actorPortalIdentityId, q.actorPortalIdentityId));
      if (q.start) conds.push(gte(auditLog.occurredAt, new Date(q.start)));
      if (q.end) conds.push(lte(auditLog.occurredAt, new Date(q.end)));

      const builder = deps.db.select().from(auditLog);
      const items = await (conds.length === 0
        ? builder.orderBy(desc(auditLog.occurredAt)).limit(q.limit)
        : builder
            .where(and(...conds))
            .orderBy(desc(auditLog.occurredAt))
            .limit(q.limit));
      res.json({ items });
    },
  );

  return router;
}
