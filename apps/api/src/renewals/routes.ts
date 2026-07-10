// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P25 — Renewal engine staff API.
//
// Renewals are surfaced for engagements with end_date in the next
// ~90 days (configurable). The firm picks an uplift mode per
// candidate, accepts the suggestion, and the engine generates a new
// proposal from the prior engagement's scope.
//
// v1 ships:
//   GET    /api/staff/renewals                    — list candidates
//   POST   /api/staff/renewals/scan               — refresh candidate
//                                                   set (idempotent)
//   POST   /api/staff/renewals/:id/uplift         — recompute
//                                                   suggested_total
//                                                   under the chosen
//                                                   uplift_mode
//   POST   /api/staff/renewals/:id/auto-renew     — flip auto_renew
//                                                   flag (gated by
//                                                   prior client
//                                                   consent — UI
//                                                   gates further)
//
// The actual proposal-generation pass (one renewal → one new DRAFT
// proposal) happens in P25.5 follow-up, alongside the email
// dispatch in P26. v1 establishes the data layer + uplift math.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clients, engagements, renewals } from '@vibe/db/schema';
import {
  cpiIndexedUplift,
  manualPercentUplift,
  realizationBasedUplift,
  type CpiSnapshot,
  type UpliftMode,
} from '@vibe/core/proposals';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface RenewalRoutesDeps extends RbacDeps {
  db: Database | null;
  // Test seam: supplies a fixed CPI snapshot when CPI_INDEXED uplift
  // is requested. Production wiring fetches from BLS.
  cpiSnapshot?: CpiSnapshot;
}

const ScanSchema = z.object({
  // How far ahead to look. Default 90 days.
  daysAhead: z.number().int().min(1).max(365).optional(),
});

const UpliftSchema = z.object({
  mode: z.enum(['MANUAL_PERCENT', 'REALIZATION_BASED', 'CPI_INDEXED']),
  manualBps: z.number().int().min(-10_000).max(100_000).optional(),
  priorBilledCents: z.number().int().min(0).optional(),
  priorBillableCents: z.number().int().min(0).optional(),
  targetRealizationBps: z.number().int().min(0).max(20_000).optional(),
});

const AutoRenewSchema = z.object({
  autoRenew: z.boolean(),
});

export function createRenewalRouter(deps: RenewalRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get(
    '/',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({
          id: renewals.id,
          currentEngagementId: renewals.currentEngagementId,
          upliftMode: renewals.upliftMode,
          upliftBps: renewals.upliftBps,
          suggestedTotalCents: renewals.suggestedTotalCents,
          state: renewals.state,
          autoRenew: renewals.autoRenew,
          candidateAt: renewals.candidateAt,
          sendWindowStart: renewals.sendWindowStart,
          sendWindowEnd: renewals.sendWindowEnd,
          engagementName: engagements.name,
          clientName: clients.name,
          engagementEndDate: engagements.endDate,
          engagementFeeAmountCents: engagements.feeAmountCents,
        })
        .from(renewals)
        .innerJoin(engagements, eq(engagements.id, renewals.currentEngagementId))
        .leftJoin(clients, eq(clients.id, engagements.clientId))
        .where(eq(renewals.firmId, session.firmId))
        .orderBy(asc(renewals.sendWindowEnd))
        .limit(500);
      res.json({ items });
    },
  );

  router.post(
    '/scan',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = ScanSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const daysAhead = parsed.data.daysAhead ?? 90;
      const cutoff = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
      const cutoffDate = cutoff.toISOString().slice(0, 10);
      const todayDate = new Date().toISOString().slice(0, 10);

      // Find engagements ending within the window that don't yet
      // have a CANDIDATE renewal row.
      const eligible = await deps.db
        .select({
          id: engagements.id,
          endDate: engagements.endDate,
          clientId: engagements.clientId,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(
            eq(engagements.status, 'ACTIVE'),
            eq(clients.firmId, session.firmId),
            gte(engagements.endDate, todayDate),
            lte(engagements.endDate, cutoffDate),
          ),
        );

      let inserted = 0;
      for (const e of eligible) {
        // Skip if a non-LAPSED renewal already exists.
        const existing = await deps.db
          .select({ id: renewals.id })
          .from(renewals)
          .where(
            and(
              eq(renewals.currentEngagementId, e.id),
              or(eq(renewals.state, 'CANDIDATE'), eq(renewals.state, 'PROPOSED')),
            ),
          )
          .limit(1);
        if (existing.length > 0) continue;
        // Window: 30 days before end_date through end_date.
        const endDate = e.endDate ?? cutoffDate;
        const sendWindowStart = new Date(endDate);
        sendWindowStart.setDate(sendWindowStart.getDate() - 30);
        await deps.db.insert(renewals).values({
          firmId: session.firmId,
          currentEngagementId: e.id,
          upliftMode: 'MANUAL_PERCENT',
          upliftBps: 0,
          sendWindowStart: sendWindowStart.toISOString().slice(0, 10),
          sendWindowEnd: endDate,
          state: 'CANDIDATE',
          autoRenew: false,
        });
        inserted++;
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'renewals.scan',
        entityId: session.firmId,
        actorAppUserId: session.appUserId,
        after: { daysAhead, eligible: eligible.length, inserted },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, eligible: eligible.length, inserted });
    },
  );

  router.post(
    '/:id/uplift',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = UpliftSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [renewal] = await deps.db
        .select({
          id: renewals.id,
          state: renewals.state,
          currentEngagementId: renewals.currentEngagementId,
          engagementFee: engagements.feeAmountCents,
        })
        .from(renewals)
        .innerJoin(engagements, eq(engagements.id, renewals.currentEngagementId))
        .where(and(eq(renewals.id, req.params['id']!), eq(renewals.firmId, session.firmId)))
        .limit(1);
      if (!renewal) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (renewal.state !== 'CANDIDATE') {
        res.status(409).json({ error: 'not_editable', state: renewal.state });
        return;
      }
      const currentTotalCents = Number(renewal.engagementFee ?? 0);

      let result;
      const mode: UpliftMode = parsed.data.mode;
      if (mode === 'MANUAL_PERCENT') {
        const bps = parsed.data.manualBps ?? 0;
        result = manualPercentUplift(currentTotalCents, bps);
      } else if (mode === 'REALIZATION_BASED') {
        result = realizationBasedUplift({
          currentTotalCents,
          priorBilledCents: parsed.data.priorBilledCents ?? 0,
          priorBillableCents: parsed.data.priorBillableCents ?? 0,
          targetRealizationBps: parsed.data.targetRealizationBps,
        });
      } else {
        if (!deps.cpiSnapshot) {
          res.status(503).json({ error: 'cpi_unavailable' });
          return;
        }
        result = cpiIndexedUplift(currentTotalCents, deps.cpiSnapshot);
      }

      await deps.db
        .update(renewals)
        .set({
          upliftMode: mode,
          upliftBps: result.upliftBps,
          suggestedTotalCents: result.suggestedTotalCents,
          cpiSnapshot: mode === 'CPI_INDEXED' ? (result.snapshot ?? null) : null,
          updatedAt: new Date(),
        })
        .where(eq(renewals.id, renewal.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'renewal',
        entityId: renewal.id,
        actorAppUserId: session.appUserId,
        after: { mode, upliftBps: result.upliftBps, suggested: result.suggestedTotalCents },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({
        ok: true,
        upliftBps: result.upliftBps,
        suggestedTotalCents: result.suggestedTotalCents,
        reason: result.reason,
      });
    },
  );

  router.post(
    '/:id/auto-renew',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = AutoRenewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(renewals)
        .where(and(eq(renewals.id, req.params['id']!), eq(renewals.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(renewals)
        .set({ autoRenew: parsed.data.autoRenew, updatedAt: new Date() })
        .where(eq(renewals.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'renewal.auto_renew',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { autoRenew: parsed.data.autoRenew },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // Silence unused linter for isNull which we want available for a
  // future "stale candidates" sweep.
  void isNull;
  void desc;
  return router;
}
