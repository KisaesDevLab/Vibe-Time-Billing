// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP6 — Portal activity log (Build Plan §2.14).
//
// Surfaces actions that are either:
//   • taken by the portal identity (sign-in, payment, file download,
//     contact verification), OR
//   • taken by firm staff on entities owned by the active client —
//     a curated allowlist that avoids leaking firm-internal events.
//
// Implementation: a UNION ALL across audit_log filtered by either
// actor_portal_identity_id OR activeClientId (the portal-side path),
// plus entity-scoped joins for staff-initiated rows on invoices,
// payments, files, client_requests, engagements, and client_portal_access.
//
// Privacy:
//   • beforeJson / afterJson are NEVER returned — they may contain
//     firm-internal columns. Only the action verb + entity-summary
//     line is exposed.
//   • Staff actor names limited to first name (no email, no full).

import express, { type Request, type Response, type Router } from 'express';
import { sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';

import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { resolveScope } from './scope';

export interface PortalActivityDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

interface RawActivityRow {
  id: string;
  occurred_at: Date | string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_app_user_first_name: string | null;
  actor_portal_identity_id: string | null;
  active_client_id: string | null;
}

export function createPortalActivityRouter(deps: PortalActivityDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const limit = Math.min(Math.max(parseInt(String(req.query['limit'] ?? '50'), 10), 10), 200);
    const scope = await resolveScope(deps.db, session, req);
    try {
      const exec = await deps.db.execute(
        sql`
          WITH allowed AS (
            SELECT
              al.id,
              al.occurred_at,
              al.action,
              al.entity_type,
              al.entity_id,
              al.actor_app_user_id,
              al.actor_portal_identity_id,
              al.active_client_id
            FROM audit_log al
            WHERE (
                -- Portal identity's own actions.
                al.actor_portal_identity_id = ${session.portalIdentityId}
                OR al.active_client_id IN (${sql.join(
                  scope.clientIds.map((c) => sql`${c}::uuid`),
                  sql`, `,
                )})
              )
              AND al.entity_type IN (
                'portal_session',
                'portal_alt_contact',
                'client_portal_access',
                'invoice',
                'payment',
                'payment_method',
                'file',
                'client_request',
                'engagement'
              )
            UNION
            -- Staff-initiated events on entities scoped clients own.
            SELECT
              al.id, al.occurred_at, al.action, al.entity_type, al.entity_id,
              al.actor_app_user_id, al.actor_portal_identity_id, al.active_client_id
            FROM audit_log al
            JOIN invoice inv ON inv.id = al.entity_id
            WHERE al.entity_type = 'invoice'
              AND inv.client_id IN (${sql.join(
                scope.clientIds.map((c) => sql`${c}::uuid`),
                sql`, `,
              )})
              AND al.actor_app_user_id IS NOT NULL
            UNION
            SELECT
              al.id, al.occurred_at, al.action, al.entity_type, al.entity_id,
              al.actor_app_user_id, al.actor_portal_identity_id, al.active_client_id
            FROM audit_log al
            JOIN client_request cr ON cr.id = al.entity_id
            WHERE al.entity_type = 'client_request'
              AND cr.engagement_id IN (
                SELECT id FROM engagement WHERE client_id IN (${sql.join(
                  scope.clientIds.map((c) => sql`${c}::uuid`),
                  sql`, `,
                )})
              )
              AND al.actor_app_user_id IS NOT NULL
            UNION
            SELECT
              al.id, al.occurred_at, al.action, al.entity_type, al.entity_id,
              al.actor_app_user_id, al.actor_portal_identity_id, al.active_client_id
            FROM audit_log al
            JOIN engagement e ON e.id = al.entity_id
            WHERE al.entity_type = 'engagement'
              AND e.client_id IN (${sql.join(
                scope.clientIds.map((c) => sql`${c}::uuid`),
                sql`, `,
              )})
              AND al.actor_app_user_id IS NOT NULL
          )
          SELECT
            a.id,
            a.occurred_at,
            a.action,
            a.entity_type,
            a.entity_id,
            au.first_name AS actor_app_user_first_name,
            a.actor_portal_identity_id,
            a.active_client_id
          FROM allowed a
          LEFT JOIN app_user au ON au.id = a.actor_app_user_id
          ORDER BY a.occurred_at DESC
          LIMIT ${limit}
        `,
      );
      const rows = (exec as unknown as { rows: RawActivityRow[] }).rows ?? [];
      const items = rows.map((r) => ({
        id: r.id,
        occurredAt:
          r.occurred_at instanceof Date
            ? r.occurred_at.toISOString()
            : new Date(String(r.occurred_at)).toISOString(),
        action: r.action,
        entityType: r.entity_type,
        // entity_id surfaced so the UI can deep-link to the relevant
        // portal page (e.g. /invoices/{id}). No staff-internal IDs
        // leak — every entity in the allowlist is one the client
        // already has visibility into elsewhere.
        entityId: r.entity_id,
        actorKind: r.actor_portal_identity_id
          ? ('self' as const)
          : r.actor_app_user_first_name
            ? ('staff' as const)
            : ('system' as const),
        actorName: r.actor_app_user_first_name,
      }));
      res.json({ items, scope: scope.isConsolidated ? 'all_accessible' : 'active' });
    } catch (err) {
      logger.error({ err }, 'portal activity feed failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}
