// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP12 — Portal appointments view (Build Plan §2.6).
//
// GET /api/portal/appointments
//   Returns upcoming SCHEDULED appointments + recent (last 30 days)
//   COMPLETED or CANCELLED. Scoped to session.activeClientId, with
//   ?scope=all_accessible support for the consolidated view.
//
// Privacy:
//   • No firm-internal fields (created_by_id, cancelled_by_id are
//     stripped — the lead app_user's first_name is included so the
//     client knows whom they're meeting).
//   • external_ref kept server-side.

import express, { type Request, type Response, type Router } from 'express';
import { and, gte, inArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, appointments, engagements } from '@vibe/db/schema';

import { addUuidIdGuard } from '../lib/uuid-guard';
import { resolveScope } from './scope';

export interface PortalAppointmentDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

export function createPortalAppointmentRouter(deps: PortalAppointmentDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const scope = await resolveScope(deps.db, session, req);
    const cutoff = new Date(Date.now() - 30 * 24 * 3600_000);
    const items = await deps.db
      .select({
        id: appointments.id,
        clientId: appointments.clientId,
        engagementId: appointments.engagementId,
        engagementName: engagements.name,
        title: appointments.title,
        description: appointments.description,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        location: appointments.location,
        locationDetail: appointments.locationDetail,
        leadName: appUsers.firstName,
        status: appointments.status,
        cancelledReason: appointments.cancelledReason,
      })
      .from(appointments)
      .leftJoin(appUsers, sql`${appUsers.id} = ${appointments.leadAppUserId}`)
      .leftJoin(engagements, sql`${engagements.id} = ${appointments.engagementId}`)
      .where(
        and(
          inArray(appointments.clientId, scope.clientIds),
          // SCHEDULED rows (all of them) + recent terminal rows. Pass the
          // cutoff as an ISO string — the postgres driver can't bind a raw
          // Date object as a query parameter in this sql fragment.
          sql`(${appointments.status} = 'SCHEDULED' OR ${appointments.startsAt} >= ${cutoff.toISOString()})`,
        ),
      )
      .orderBy(appointments.startsAt);
    res.json({
      items,
      scope: scope.isConsolidated ? 'all_accessible' : 'active',
    });
    void gte; // imports retained for future filter expansions
  });

  return router;
}
