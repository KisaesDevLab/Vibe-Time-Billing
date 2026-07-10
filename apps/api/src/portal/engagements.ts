// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP4 — Portal engagement status board (Build Plan §2.5).
//
// GET /api/portal/engagements/active
//   Returns active engagements for the session's activeClientId with
//   denormalized status fields:
//     • name + period (startDate → endDate or dueDate)
//     • partner display name (no email — privacy)
//     • status pill key: in_progress | awaiting_client | scheduled |
//                         filed | blocked | paused
//     • progress pct (0-100) — derived from milestones when present,
//       null otherwise
//     • next milestone {name, dueDate} (next pending row by sequence)
//     • lastActivity ISO timestamp (engagement.updatedAt)
//     • awaitingFromYou count — OPEN client_request rows
//
// Privacy:
//   • Engagement budget / fee / rate columns NEVER returned.
//   • Staff names limited to the partner display name (no email,
//     no manager, no assigned-request staff).
//   • Computed in a single round-trip via Postgres GROUP BY +
//     correlated subqueries to keep the response shape compact.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientRequests,
  clients,
  engagementStatusConfig,
  engagements,
  milestonePlans,
  milestones,
} from '@vibe/db/schema';

import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { resolveScope } from './scope';

export interface PortalEngagementDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

export type PortalStatusPill =
  | 'in_progress'
  | 'awaiting_client'
  | 'scheduled'
  | 'filed'
  | 'blocked'
  | 'paused';

export function pillFor(args: {
  engagementStatus: string;
  workflowState: string;
  openRequestCount: number;
}): PortalStatusPill {
  if (args.engagementStatus === 'PAUSED') return 'paused';
  if (args.engagementStatus === 'CLOSED') return 'filed';
  if (args.engagementStatus === 'PROPOSED') return 'scheduled';
  // ACTIVE — derive from workflow + outstanding requests.
  if (args.workflowState === 'BLOCKED') return 'blocked';
  if (args.openRequestCount > 0) return 'awaiting_client';
  if (args.workflowState === 'SCHEDULED' || args.workflowState === 'NOT_STARTED') {
    return 'scheduled';
  }
  return 'in_progress';
}

export function createPortalEngagementRouter(deps: PortalEngagementDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/active', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const scope = await resolveScope(deps.db, session, req);
    try {
      const exec = await deps.db.execute(
        sql`SELECT
              e.id,
              e.client_id                       AS client_id,
              e.name,
              e.status                          AS engagement_status,
              e.workflow_state                  AS workflow_state,
              e.start_date::text                AS start_date,
              e.end_date::text                  AS end_date,
              e.due_date::text                  AS due_date,
              e.updated_at                      AS last_activity,
              partner.full_name                 AS partner_name,
              esc.client_label                  AS client_label,
              esc.client_description            AS client_description,
              esc.client_visible                AS client_visible,
              (
                SELECT COUNT(*)::int FROM ${clientRequests} cr
                WHERE cr.engagement_id = e.id AND cr.status = 'OPEN'
              )                                 AS open_request_count,
              (
                SELECT COUNT(*)::int FROM ${milestones} m
                JOIN ${milestonePlans} mp ON mp.id = m.plan_id
                WHERE mp.engagement_id = e.id
              )                                 AS total_milestones,
              (
                SELECT COUNT(*)::int FROM ${milestones} m
                JOIN ${milestonePlans} mp ON mp.id = m.plan_id
                WHERE mp.engagement_id = e.id AND m.status IN ('TRIGGERED', 'INVOICED')
              )                                 AS completed_milestones,
              (
                SELECT json_build_object(
                  'id', m.id,
                  'name', m.name,
                  'dueDate', m.trigger_date::text
                )
                FROM ${milestones} m
                JOIN ${milestonePlans} mp ON mp.id = m.plan_id
                WHERE mp.engagement_id = e.id AND m.status = 'PENDING'
                ORDER BY m.sequence ASC
                LIMIT 1
              )                                 AS next_milestone
            FROM ${engagements} e
            LEFT JOIN ${appUsers} partner ON partner.id = e.partner_id
            LEFT JOIN ${clients} c ON c.id = e.client_id
            LEFT JOIN ${engagementStatusConfig} esc
              ON esc.firm_id = c.firm_id AND esc.workflow_state = e.workflow_state
            WHERE e.client_id IN (${sql.join(
              scope.clientIds.map((c) => sql`${c}::uuid`),
              sql`, `,
            )})
              AND e.status IN ('ACTIVE', 'PAUSED')
            ORDER BY
              CASE e.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,
              e.due_date NULLS LAST,
              e.created_at DESC
            LIMIT 50`,
      );
      const rows =
        (
          exec as unknown as {
            rows: Array<{
              id: string;
              client_id: string;
              name: string;
              engagement_status: string;
              workflow_state: string;
              start_date: string | null;
              end_date: string | null;
              due_date: string | null;
              last_activity: Date | string;
              partner_name: string | null;
              client_label: string | null;
              client_description: string | null;
              client_visible: boolean | null;
              open_request_count: number;
              total_milestones: number;
              completed_milestones: number;
              next_milestone: { id: string; name: string; dueDate: string | null } | null;
            }>;
          }
        ).rows ?? [];

      const items = rows.map((r) => {
        const progressPct =
          r.total_milestones > 0
            ? Math.round((r.completed_milestones / r.total_milestones) * 100)
            : null;
        return {
          id: r.id,
          clientId: r.client_id,
          name: r.name,
          partnerName: r.partner_name,
          startDate: r.start_date,
          endDate: r.end_date,
          dueDate: r.due_date,
          lastActivity:
            r.last_activity instanceof Date
              ? r.last_activity.toISOString()
              : String(r.last_activity),
          statusPill: pillFor({
            engagementStatus: r.engagement_status,
            workflowState: r.workflow_state,
            openRequestCount: r.open_request_count,
          }),
          // 0101 — firm-defined client-facing text overrides the derived
          // pill when set + visible; otherwise null and the portal falls
          // back to the statusPill label.
          clientLabel: r.client_visible === false ? null : r.client_label,
          clientDescription: r.client_visible === false ? null : r.client_description,
          progressPct,
          nextMilestone: r.next_milestone,
          awaitingFromYou: r.open_request_count,
        };
      });
      res.json({ items, scope: scope.isConsolidated ? 'all_accessible' : 'active' });
    } catch (err) {
      logger.error({ err }, 'portal engagements/active failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}

// Suppress unused-import warning for `and` / `eq` retained in case of
// future filter additions.
void and;
void eq;
