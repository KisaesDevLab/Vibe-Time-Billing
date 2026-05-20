// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Rate management endpoints (Phase 7). The effective-dated history view
// lets staff see every rate that resolved for a given timekeeper over
// time — useful for audit/reconciliation of historical invoices.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientRateOverrides,
  clients,
  engagementRateOverrides,
  engagements,
  serviceLineRates,
  serviceLines,
  timekeeperRates,
} from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface RateRoutesDeps extends RbacDeps {
  db: Database | null;
}

export function createRateRouter(deps: RateRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/history',
    requirePermission(deps, 'rate:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ timekeeper: [], client: [], engagement: [], serviceLine: [] });
        return;
      }
      const appUserId = typeof req.query['appUserId'] === 'string' ? req.query['appUserId'] : null;
      if (!appUserId) {
        res.status(400).json({ error: 'app_user_id_required' });
        return;
      }

      // Confirm the user belongs to the requester's firm.
      const [user] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, appUserId), eq(appUsers.firmId, session.firmId)))
        .limit(1);
      if (!user) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }

      const tk = await deps.db
        .select()
        .from(timekeeperRates)
        .where(eq(timekeeperRates.appUserId, appUserId))
        .orderBy(desc(timekeeperRates.effectiveStart));

      const cl = await deps.db
        .select({
          id: clientRateOverrides.id,
          clientId: clientRateOverrides.clientId,
          clientName: clients.name,
          billRateCents: clientRateOverrides.billRateCents,
          effectiveStart: clientRateOverrides.effectiveStart,
          effectiveEnd: clientRateOverrides.effectiveEnd,
        })
        .from(clientRateOverrides)
        .innerJoin(clients, eq(clients.id, clientRateOverrides.clientId))
        .where(
          and(eq(clientRateOverrides.appUserId, appUserId), eq(clients.firmId, session.firmId)),
        )
        .orderBy(desc(clientRateOverrides.effectiveStart));

      const eng = await deps.db
        .select({
          id: engagementRateOverrides.id,
          engagementId: engagementRateOverrides.engagementId,
          engagementName: engagements.name,
          billRateCents: engagementRateOverrides.billRateCents,
          effectiveStart: engagementRateOverrides.effectiveStart,
        })
        .from(engagementRateOverrides)
        .innerJoin(engagements, eq(engagements.id, engagementRateOverrides.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(eq(engagementRateOverrides.appUserId, appUserId), eq(clients.firmId, session.firmId)),
        )
        .orderBy(desc(engagementRateOverrides.effectiveStart));

      const sl = await deps.db
        .select({
          id: serviceLineRates.id,
          serviceLineId: serviceLineRates.serviceLineId,
          serviceLineName: serviceLines.name,
          billRateCents: serviceLineRates.billRateCents,
          effectiveStart: serviceLineRates.effectiveStart,
          effectiveEnd: serviceLineRates.effectiveEnd,
        })
        .from(serviceLineRates)
        .innerJoin(serviceLines, eq(serviceLines.id, serviceLineRates.serviceLineId))
        .where(eq(serviceLines.firmId, session.firmId))
        .orderBy(desc(serviceLineRates.effectiveStart));

      res.json({ timekeeper: tk, client: cl, engagement: eng, serviceLine: sl });
    },
  );

  router.post(
    '/bulk-update/preview',
    requirePermission(deps, 'rate:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ rows: [] });
        return;
      }
      const body = req.body as { pctChange?: unknown; appUserIds?: unknown };
      const pct = typeof body.pctChange === 'number' ? body.pctChange : NaN;
      if (!Number.isFinite(pct)) {
        res.status(400).json({ error: 'pct_change_required' });
        return;
      }
      const userIdFilter = Array.isArray(body.appUserIds)
        ? body.appUserIds.filter((x): x is string => typeof x === 'string')
        : null;
      const currentConds = [eq(appUsers.firmId, session.firmId)];
      if (userIdFilter && userIdFilter.length > 0) {
        // intentionally restrict to provided users in firm scope
      }
      const users = await deps.db
        .select({ id: appUsers.id, fullName: appUsers.fullName })
        .from(appUsers)
        .where(and(...currentConds));
      const rates = await deps.db.select().from(timekeeperRates);
      const byUser = new Map<string, (typeof rates)[number][]>();
      for (const r of rates) {
        const list = byUser.get(r.appUserId) ?? [];
        list.push(r);
        byUser.set(r.appUserId, list);
      }
      const today = new Date().toISOString().slice(0, 10);
      const rows = users
        .filter((u) => !userIdFilter || userIdFilter.includes(u.id))
        .map((u) => {
          const userRates = byUser.get(u.id) ?? [];
          const current = userRates
            .filter(
              (r) => r.effectiveStart <= today && (!r.effectiveEnd || r.effectiveEnd >= today),
            )
            .sort((a, b) => (a.effectiveStart < b.effectiveStart ? 1 : -1))[0];
          if (!current) return null;
          const currentCents = current.billRateCents;
          const newCents = Math.round(currentCents * (1 + pct / 100));
          return {
            appUserId: u.id,
            fullName: u.fullName,
            currentBillRateCents: currentCents,
            proposedBillRateCents: newCents,
            deltaCents: newCents - currentCents,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      res.json({ rows, pctChange: pct });
    },
  );

  return router;
}
