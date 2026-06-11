// SPDX-License-Identifier: Elastic-2.0
//
// Engagement progress-status (workflow_state) change history.
//
// Surfaces the already-logged audit rows (entity_type
// 'engagement_workflow_state', written by emitAudit on the workflow-state
// PATCH) as a readable timeline: WHO changed an engagement's status, WHEN,
// and OLD -> NEW. Actor names come from app_user; old/new keys are resolved
// to their catalog labels (falling back to the raw key if a custom status
// was later deleted). Firm scoping goes through client.firm_id because the
// engagement table has no firm_id column.

import express, { type Request, type Response, type Router } from 'express';
import { sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, auditLog, clients, engagementStatusConfig, engagements } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface StatusHistoryRow {
  occurredAt: string;
  actorName: string | null;
  engagementId: string;
  engagementName: string | null;
  fromKey: string | null;
  fromLabel: string | null;
  toKey: string | null;
  toLabel: string | null;
}

export interface StatusHistoryFilter {
  firmId: string;
  engagementId?: string;
  actorAppUserId?: string;
  start?: string;
  end?: string;
  limit?: number;
}

export async function queryStatusHistory(
  db: Database,
  f: StatusHistoryFilter,
): Promise<StatusHistoryRow[]> {
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
  const conds = [
    sql`a.entity_type = 'engagement_workflow_state'`,
    sql`c.firm_id = ${f.firmId}::uuid`,
  ];
  if (f.engagementId) conds.push(sql`a.entity_id = ${f.engagementId}::uuid`);
  if (f.actorAppUserId) conds.push(sql`a.actor_app_user_id = ${f.actorAppUserId}::uuid`);
  if (f.start) conds.push(sql`a.occurred_at >= ${f.start}::timestamptz`);
  if (f.end) conds.push(sql`a.occurred_at <= ${f.end}::timestamptz`);

  const exec = await db.execute(sql`
    SELECT
      a.occurred_at                                        AS occurred_at,
      u.full_name                                          AS actor_name,
      e.id                                                 AS engagement_id,
      e.name                                               AS engagement_name,
      a.before_json->>'workflowState'                      AS from_key,
      COALESCE(fc.label, a.before_json->>'workflowState')  AS from_label,
      a.after_json->>'workflowState'                       AS to_key,
      COALESCE(tc.label, a.after_json->>'workflowState')   AS to_label
    FROM ${auditLog} a
    JOIN ${engagements} e ON e.id = a.entity_id
    JOIN ${clients} c ON c.id = e.client_id
    LEFT JOIN ${appUsers} u ON u.id = a.actor_app_user_id
    LEFT JOIN ${engagementStatusConfig} fc
      ON fc.firm_id = c.firm_id AND fc.workflow_state = a.before_json->>'workflowState'
    LEFT JOIN ${engagementStatusConfig} tc
      ON tc.firm_id = c.firm_id AND tc.workflow_state = a.after_json->>'workflowState'
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY a.occurred_at DESC
    LIMIT ${limit}
  `);

  const rows =
    (
      exec as unknown as {
        rows: Array<{
          occurred_at: Date | string;
          actor_name: string | null;
          engagement_id: string;
          engagement_name: string | null;
          from_key: string | null;
          from_label: string | null;
          to_key: string | null;
          to_label: string | null;
        }>;
      }
    ).rows ?? [];

  return rows.map((r) => ({
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
    actorName: r.actor_name,
    engagementId: r.engagement_id,
    engagementName: r.engagement_name,
    fromKey: r.from_key,
    fromLabel: r.from_label,
    toKey: r.to_key,
    toLabel: r.to_label,
  }));
}

export interface StatusHistoryRoutesDeps extends RbacDeps {
  db: Database | null;
}

// Firm-wide report router — mounted at /api/staff/engagement-status-history
// (a distinct path so it never collides with the engagements /:id routes).
export function createStatusHistoryRouter(deps: StatusHistoryRoutesDeps): Router {
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
      try {
        const items = await queryStatusHistory(deps.db, {
          firmId,
          actorAppUserId:
            typeof req.query['actorAppUserId'] === 'string'
              ? req.query['actorAppUserId']
              : undefined,
          start: typeof req.query['start'] === 'string' ? req.query['start'] : undefined,
          end: typeof req.query['end'] === 'string' ? req.query['end'] : undefined,
          limit: typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : undefined,
        });
        res.json({ items });
      } catch (err) {
        logger.error({ err }, 'status-history report failed');
        res.status(500).json({ error: 'internal' });
      }
    },
  );

  return router;
}
