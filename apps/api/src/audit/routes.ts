// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Audit-log viewer (Phase 19). Read-only; the audit_log table is
// append-only at the DB role level.

import express, { type Request, type Response, type Router } from 'express';
import { csvField } from '../lib/csv';
import { z } from 'zod';
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  alertDismissals,
  appUsers,
  auditLog,
  clients,
  engagements,
  invoices,
  mcpTokens,
} from '@vibe/db/schema';

// Worker-emitted alert kinds surfaced by the Alerts inbox.
const ALERT_KINDS = [
  'audit_anomaly_alert',
  'scope_creep_alert',
  'wip_age_alert',
  'engagement_rollover',
];

import { logger } from '../logger';
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
  // Free-text match across entity type / id / ip / user-agent (folds in the
  // old /search endpoint so the list can page + name-enrich a text search).
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(250).optional(),
});

type AuditRowLike = {
  actorAppUserId: string | null;
  actorMcpTokenId: string | null;
  actorPortalIdentityId: string | null;
  entityType: string;
  entityId: string | null;
};

// Attach human names to audit rows: the actor (staff user / MCP token / portal
// identity) and the entity (for the common entity types — engagement, client,
// invoice, app_user). Unmapped types leave entityName null (UI falls back to
// the full id). Batched to keep it a handful of queries regardless of page size.
async function enrichWithNames<T extends AuditRowLike>(
  db: Database,
  rows: T[],
): Promise<Array<T & { actorName: string | null; entityName: string | null }>> {
  const appUserIds = new Set<string>();
  const tokenIds = new Set<string>();
  const engIds = new Set<string>();
  const clientIds = new Set<string>();
  const invoiceIds = new Set<string>();
  for (const r of rows) {
    if (r.actorAppUserId) appUserIds.add(r.actorAppUserId);
    if (r.actorMcpTokenId) tokenIds.add(r.actorMcpTokenId);
    if (r.entityId) {
      if (r.entityType === 'engagement') engIds.add(r.entityId);
      else if (r.entityType === 'client') clientIds.add(r.entityId);
      else if (r.entityType === 'invoice') invoiceIds.add(r.entityId);
      else if (r.entityType === 'app_user' || r.entityType === 'staff_user')
        appUserIds.add(r.entityId);
    }
  }
  const toMap = (rs: Array<{ id: string; name: string | null }>): Map<string, string | null> =>
    new Map(rs.map((x) => [x.id, x.name]));
  const empty = (): Map<string, string | null> => new Map();
  const [users, tokens, engs, clis, invs] = await Promise.all([
    appUserIds.size
      ? db
          .select({ id: appUsers.id, name: appUsers.fullName })
          .from(appUsers)
          .where(inArray(appUsers.id, [...appUserIds]))
          .then(toMap)
      : empty(),
    tokenIds.size
      ? db
          .select({ id: mcpTokens.id, name: mcpTokens.name })
          .from(mcpTokens)
          .where(inArray(mcpTokens.id, [...tokenIds]))
          .then(toMap)
      : empty(),
    engIds.size
      ? db
          .select({ id: engagements.id, name: engagements.name })
          .from(engagements)
          .where(inArray(engagements.id, [...engIds]))
          .then(toMap)
      : empty(),
    clientIds.size
      ? db
          .select({ id: clients.id, name: clients.name })
          .from(clients)
          .where(inArray(clients.id, [...clientIds]))
          .then(toMap)
      : empty(),
    invoiceIds.size
      ? db
          .select({ id: invoices.id, name: invoices.invoiceNumber })
          .from(invoices)
          .where(inArray(invoices.id, [...invoiceIds]))
          .then(toMap)
      : empty(),
  ]);
  return rows.map((r) => {
    let actorName: string | null = null;
    if (r.actorAppUserId) actorName = users.get(r.actorAppUserId) ?? null;
    else if (r.actorMcpTokenId) actorName = `MCP token: ${tokens.get(r.actorMcpTokenId) ?? '?'}`;
    else if (r.actorPortalIdentityId) actorName = 'Portal user';
    let entityName: string | null = null;
    if (r.entityId) {
      if (r.entityType === 'engagement') entityName = engs.get(r.entityId) ?? null;
      else if (r.entityType === 'client') entityName = clis.get(r.entityId) ?? null;
      else if (r.entityType === 'invoice') entityName = invs.get(r.entityId) ?? null;
      else if (r.entityType === 'app_user' || r.entityType === 'staff_user')
        entityName = users.get(r.entityId) ?? null;
    }
    return { ...r, actorName, entityName };
  });
}

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
      // Free-text match (entity type / id / ip / user-agent). entityId is a
      // uuid → cast to text before ILIKE (no uuid ILIKE operator).
      if (q.q && q.q.length >= 2) {
        const like = `%${q.q.replace(/[%_]/g, '\\$&')}%`;
        const match = or(
          ilike(auditLog.entityType, like),
          sql`${auditLog.entityId}::text ILIKE ${like}`,
          ilike(auditLog.ip, like),
          ilike(auditLog.userAgent, like),
        );
        if (match) conds.push(match);
      }

      const where = conds.length === 0 ? undefined : and(...conds);

      // Paginated envelope when `page` is supplied; else the legacy capped
      // `{ items }` shape (back-compat for other callers).
      if (q.page != null) {
        const pageSize = q.pageSize ?? 50;
        const [totalRow] = await deps.db
          .select({ total: sql<number>`COUNT(*)`.as('total') })
          .from(auditLog)
          .where(where);
        const total = Number(totalRow?.total ?? 0);
        const rows = await deps.db
          .select()
          .from(auditLog)
          .where(where)
          .orderBy(desc(auditLog.occurredAt))
          .limit(pageSize)
          .offset((q.page - 1) * pageSize);
        const enriched = await enrichWithNames(deps.db, rows);
        res.json({ rows: enriched, items: enriched, total, page: q.page, pageSize });
        return;
      }

      const items = await deps.db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.occurredAt))
        .limit(q.limit);
      res.json({ items: await enrichWithNames(deps.db, items) });
    },
  );

  router.get(
    '/by-ip/:ip',
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
        .where(and(eq(auditLog.ip, req.params['ip']!), gte(auditLog.occurredAt, since)))
        .orderBy(desc(auditLog.occurredAt))
        .limit(500);
      res.json({ items });
    },
  );

  router.get(
    '/webhook-events',
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
        .where(and(eq(auditLog.action, 'WEBHOOK_DELIVERY'), gte(auditLog.occurredAt, since)))
        .orderBy(desc(auditLog.occurredAt))
        .limit(500);
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

  // -----------------------------------------------------------------
  // Full-text-ish search across audit_log (Phase 19 #9). Matches against
  // action / entity_type / entity_id / ip / user-agent. Returns the 200
  // most recent matches.
  // -----------------------------------------------------------------
  router.get(
    '/search',
    requirePermission(deps, 'admin:audit:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const q = String(req.query['q'] ?? '').trim();
      if (q.length < 2) {
        res.json({ items: [] });
        return;
      }
      // QA fix — entityId is uuid in Postgres, which has no ILIKE
      // operator. Postgres throws 42883 and (until the unhandled-
      // rejection handler was added) the request hung. Cast the
      // uuid column to text before the comparison, and wrap the
      // whole handler in try/catch so future query failures return
      // a 500 instead of stranding the connection.
      try {
        const { ilike, or, sql: sqlRaw } = await import('drizzle-orm');
        const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
        const match = or(
          ilike(auditLog.entityType, like),
          sqlRaw`${auditLog.entityId}::text ILIKE ${like}`,
          ilike(auditLog.ip, like),
          ilike(auditLog.userAgent, like),
        );
        const items = await deps.db
          .select()
          .from(auditLog)
          .where(match)
          .orderBy(desc(auditLog.occurredAt))
          .limit(200);
        res.json({ items });
      } catch (err) {
        logger.error({ err }, 'audit search failed');
        res.status(500).json({ error: 'search_failed' });
      }
    },
  );

  // -----------------------------------------------------------------
  // Outbound-notification log. Surfaces recent dunning + magic-link
  // sends. Pulled from dunning_history (real send ledger) joined with
  // invoice for context.
  // -----------------------------------------------------------------
  router.get(
    '/notifications/recent',
    requirePermission(deps, 'admin:audit:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const days = Math.min(Math.max(parseInt(String(req.query['days'] ?? '14'), 10) || 14, 1), 90);
      const since = new Date(Date.now() - days * 86_400_000);
      const { dunningHistory, invoices } = await import('@vibe/db/schema');
      const items = await deps.db
        .select({
          id: dunningHistory.id,
          invoiceId: dunningHistory.invoiceId,
          invoiceNumber: invoices.invoiceNumber,
          stepKind: dunningHistory.stepKind,
          sentAt: dunningHistory.sentAt,
          channel: dunningHistory.channel,
          recipient: dunningHistory.recipient,
          outcome: dunningHistory.outcome,
          errorMessage: dunningHistory.errorMessage,
        })
        .from(dunningHistory)
        .innerJoin(invoices, eq(invoices.id, dunningHistory.invoiceId))
        .where(and(eq(invoices.firmId, session.firmId), gte(dunningHistory.sentAt, since)))
        .orderBy(desc(dunningHistory.sentAt))
        .limit(500);
      res.json({ items });
    },
  );

  // -----------------------------------------------------------------
  // Inbox: surfaces alerts emitted by the workers
  // (audit_anomaly_alert, scope_creep_alert, wip_age_alert,
  //  engagement_rollover). Read-only firm-scoped view.
  // -----------------------------------------------------------------
  router.get(
    '/alerts',
    requirePermission(deps, 'admin:audit:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const firmId = req.staffSession!.firmId;
      // Exclude alerts a staff member has already dismissed (firm-wide).
      const dismissed = deps.db
        .select({ id: alertDismissals.auditLogId })
        .from(alertDismissals)
        .where(eq(alertDismissals.firmId, firmId));
      const items = await deps.db
        .select({
          id: auditLog.id,
          occurredAt: auditLog.occurredAt,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          afterJson: auditLog.afterJson,
        })
        .from(auditLog)
        .where(and(inArray(auditLog.entityType, ALERT_KINDS), notInArray(auditLog.id, dismissed)))
        .orderBy(desc(auditLog.occurredAt))
        .limit(200);
      res.json({ items });
    },
  );

  // Dismiss a worker alert so it drops off the inbox + dashboard callout.
  router.post(
    '/alerts/:id/dismiss',
    requirePermission(deps, 'admin:audit:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = z.string().uuid().safeParse(req.params['id']);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_id' });
        return;
      }
      const { firmId, appUserId } = req.staffSession!;
      // Defensive: only allow dismissing rows that are actually alerts.
      const [row] = await deps.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.id, parsed.data), inArray(auditLog.entityType, ALERT_KINDS)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'alert_not_found' });
        return;
      }
      await deps.db
        .insert(alertDismissals)
        .values({ firmId, auditLogId: parsed.data, dismissedByAppUserId: appUserId })
        .onConflictDoNothing();
      res.json({ ok: true });
    },
  );

  // Dismiss every alert currently in the firm's inbox in one shot. Mirrors the
  // single dismiss but fans out over all not-yet-dismissed alert rows.
  router.post(
    '/alerts/dismiss-all',
    requirePermission(deps, 'admin:audit:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const { firmId, appUserId } = req.staffSession!;
      const dismissed = deps.db
        .select({ id: alertDismissals.auditLogId })
        .from(alertDismissals)
        .where(eq(alertDismissals.firmId, firmId));
      const open = await deps.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(inArray(auditLog.entityType, ALERT_KINDS), notInArray(auditLog.id, dismissed)));
      if (open.length === 0) {
        res.json({ ok: true, dismissed: 0 });
        return;
      }
      await deps.db
        .insert(alertDismissals)
        .values(open.map((r) => ({ firmId, auditLogId: r.id, dismissedByAppUserId: appUserId })))
        .onConflictDoNothing();
      res.json({ ok: true, dismissed: open.length });
    },
  );

  return router;
}

function csvCell(s: string): string {
  return csvField(s);
}
