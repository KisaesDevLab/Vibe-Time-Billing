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
  action: z
    .enum([
      'CREATE',
      'UPDATE',
      'ARCHIVE',
      'RESTORE',
      'LOGIN',
      'LOGOUT',
      'STEP_UP',
      'EXPORT',
      'IMPERSONATE',
      'PAYMENT',
      'WEBHOOK_DELIVERY',
      'MCP_CALL',
      'AI_REQUEST',
      'BACKUP',
      'RESTORE_DATABASE',
    ])
    .optional(),
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
      if (q.action) conds.push(eq(auditLog.action, q.action));
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

  router.get(
    '/by-actor/:actorAppUserId',
    requirePermission(deps, 'admin:audit:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const days = Math.min(
        Math.max(parseInt(String(req.query['days'] ?? '30'), 10) || 30, 1),
        365,
      );
      const since = new Date(Date.now() - days * 86_400_000);
      const items = await deps.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.actorAppUserId, req.params['actorAppUserId']!),
            gte(auditLog.occurredAt, since),
          ),
        )
        .orderBy(desc(auditLog.occurredAt))
        .limit(500);
      res.json({ items });
    },
  );

  router.get(
    '/by-entity/:entityType/:entityId',
    requirePermission(deps, 'admin:audit:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entityType, req.params['entityType']!),
            eq(auditLog.entityId, req.params['entityId']!),
          ),
        )
        .orderBy(desc(auditLog.occurredAt))
        .limit(200);
      res.json({ items });
    },
  );

  router.get(
    '/export.csv',
    requirePermission(deps, 'admin:audit:export'),
    async (req: Request, res: Response) => {
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_query' });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const conds: SQL<unknown>[] = [];
      const q = parsed.data;
      if (q.entityType) conds.push(eq(auditLog.entityType, q.entityType));
      if (q.entityId) conds.push(eq(auditLog.entityId, q.entityId));
      if (q.actorAppUserId) conds.push(eq(auditLog.actorAppUserId, q.actorAppUserId));
      if (q.actorPortalIdentityId)
        conds.push(eq(auditLog.actorPortalIdentityId, q.actorPortalIdentityId));
      if (q.action) conds.push(eq(auditLog.action, q.action));
      if (q.start) conds.push(gte(auditLog.occurredAt, new Date(q.start)));
      if (q.end) conds.push(lte(auditLog.occurredAt, new Date(q.end)));
      const builder = deps.db.select().from(auditLog);
      // CSV export defaults higher than default 100 because operators
      // export windows tend to be days/weeks.
      const limit = Math.min(q.limit, 5000);
      const rows = await (conds.length === 0
        ? builder.orderBy(desc(auditLog.occurredAt)).limit(limit)
        : builder
            .where(and(...conds))
            .orderBy(desc(auditLog.occurredAt))
            .limit(limit));
      const header = [
        'occurredAt',
        'action',
        'entityType',
        'entityId',
        'actorAppUserId',
        'actorPortalIdentityId',
        'ip',
        'userAgent',
      ];
      const lines = [header.join(',')];
      for (const r of rows) {
        const row = r as Record<string, unknown>;
        lines.push(
          [
            (row['occurredAt'] as Date | undefined)?.toISOString() ?? '',
            row['action'] ?? '',
            row['entityType'] ?? '',
            row['entityId'] ?? '',
            row['actorAppUserId'] ?? '',
            row['actorPortalIdentityId'] ?? '',
            row['ip'] ?? '',
            csvCell(String(row['userAgent'] ?? '')),
          ]
            .map((c) => (typeof c === 'string' ? c : String(c)))
            .join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(lines.join('\n') + '\n');
    },
  );

  return router;
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
