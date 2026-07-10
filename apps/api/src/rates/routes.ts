// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Rate management endpoints (Phase 7, rewritten for 0054 rate codes).
//
// The flat /rates/timekeeper POST is gone — snapshot creation now lives
// under /admin/users/:id/rate-snapshots (append-only). Bulk update,
// loaded margin, resolve-debug, history, and the override endpoints
// still live here and have been rewired to the new snapshot model.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientRateOverrides,
  clients,
  engagementRateOverrides,
  engagements,
  rateCodes,
  serviceLineRates,
  serviceLines,
  staffRateSnapshotEntries,
  staffRateSnapshots,
} from '@vibe/db/schema';
import { resolveRate, type RateCandidate } from '@vibe/core/rates';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ClientOverrideSchema = z.object({
  clientId: z.string().uuid(),
  appUserId: z.string().uuid(),
  billRateCents: z.number().int().positive(),
  effectiveStart: z.string().regex(DATE_RE),
  effectiveEnd: z.string().regex(DATE_RE).optional(),
});

const EngagementOverrideSchema = z.object({
  engagementId: z.string().uuid(),
  appUserId: z.string().uuid(),
  billRateCents: z.number().int().positive(),
  effectiveStart: z.string().regex(DATE_RE),
});

const ServiceLineRateSchema = z.object({
  serviceLineId: z.string().uuid(),
  roleId: z.string().uuid(),
  billRateCents: z.number().int().positive(),
  effectiveStart: z.string().regex(DATE_RE),
  effectiveEnd: z.string().regex(DATE_RE).optional(),
});

export interface RateRoutesDeps extends RbacDeps {
  db: Database | null;
}

export function createRateRouter(deps: RateRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // -----------------------------------------------------------------
  // GET /history — staff snapshot rows + per-level overrides for one user
  // -----------------------------------------------------------------
  router.get(
    '/history',
    requirePermission(deps, 'rate:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ snapshots: [], client: [], engagement: [], serviceLine: [] });
        return;
      }
      const appUserId = uuidQueryParam(req.query['appUserId']);
      if (appUserId === 'invalid') {
        res.status(400).json({ error: 'invalid_app_user_id' });
        return;
      }
      if (!appUserId) {
        res.status(400).json({ error: 'app_user_id_required' });
        return;
      }

      const [user] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, appUserId), eq(appUsers.firmId, session.firmId)))
        .limit(1);
      if (!user) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }

      // Snapshots flattened with one row per (snapshot, code).
      const snap = await deps.db
        .select({
          snapshotId: staffRateSnapshots.id,
          effectiveDate: staffRateSnapshots.effectiveDate,
          costRateCents: staffRateSnapshots.costRateCents,
          rateCodeId: staffRateSnapshotEntries.rateCodeId,
          code: rateCodes.code,
          description: rateCodes.description,
          billRateCents: staffRateSnapshotEntries.billRateCents,
        })
        .from(staffRateSnapshots)
        .innerJoin(
          staffRateSnapshotEntries,
          eq(staffRateSnapshotEntries.snapshotId, staffRateSnapshots.id),
        )
        .innerJoin(rateCodes, eq(rateCodes.id, staffRateSnapshotEntries.rateCodeId))
        .where(eq(staffRateSnapshots.appUserId, appUserId))
        .orderBy(desc(staffRateSnapshots.effectiveDate), rateCodes.sortOrder);

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

      res.json({ snapshots: snap, client: cl, engagement: eng, serviceLine: sl });
    },
  );

  // -----------------------------------------------------------------
  // POST /bulk-update/preview — proposed StandardRate-only changes
  // -----------------------------------------------------------------
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

      const standardRows = await currentStandardRateRows(deps.db, session.firmId);
      const rows = standardRows
        .filter((r) => !userIdFilter || userIdFilter.includes(r.appUserId))
        .map((r) => {
          const newCents = Math.round(r.billRateCents * (1 + pct / 100));
          return {
            appUserId: r.appUserId,
            fullName: r.fullName,
            currentBillRateCents: r.billRateCents,
            proposedBillRateCents: newCents,
            deltaCents: newCents - r.billRateCents,
          };
        });
      res.json({ rows, pctChange: pct });
    },
  );

  // -----------------------------------------------------------------
  // POST /bulk-update/commit — opens a new snapshot per user with the
  // multiplied StandardRate; non-StandardRate entries copy forward.
  // -----------------------------------------------------------------
  router.post(
    '/bulk-update/commit',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, updated: 0 });
        return;
      }
      const body = req.body as {
        pctChange?: unknown;
        effectiveStart?: unknown;
        appUserIds?: unknown;
      };
      const pct = typeof body.pctChange === 'number' ? body.pctChange : NaN;
      const effectiveDate = typeof body.effectiveStart === 'string' ? body.effectiveStart : null;
      if (!Number.isFinite(pct) || !effectiveDate || !DATE_RE.test(effectiveDate)) {
        res.status(400).json({ error: 'pct_change_and_effective_start_required' });
        return;
      }
      const userIdFilter = Array.isArray(body.appUserIds)
        ? body.appUserIds.filter((x): x is string => typeof x === 'string')
        : null;

      const standardRows = await currentStandardRateRows(deps.db, session.firmId);
      const targets = standardRows.filter(
        (r) => !userIdFilter || userIdFilter.includes(r.appUserId),
      );
      let updated = 0;
      for (const r of targets) {
        const newStandard = Math.round(r.billRateCents * (1 + pct / 100));
        try {
          await createSnapshot(deps.db, {
            appUserId: r.appUserId,
            effectiveDate,
            costRateCents: r.costRateCents,
            entriesFromPrior: true,
            standardRateCodeId: r.standardRateCodeId,
            standardBillRateCents: newStandard,
          });
          updated++;
        } catch (err) {
          logger.warn({ err, userId: r.appUserId }, 'bulk snapshot insert failed');
        }
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'staff_rate_snapshot',
        actorAppUserId: session.appUserId,
        after: { kind: 'bulk_update', pctChange: pct, effectiveDate, updated },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, updated });
    },
  );

  // -----------------------------------------------------------------
  // GET /loaded-margin — current StandardRate bill vs snapshot cost
  // -----------------------------------------------------------------
  router.get(
    '/loaded-margin',
    requirePermission(deps, 'rate:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const rows = await currentStandardRateRows(deps.db, session.firmId);
      const items = rows.map((r) => {
        const bill = r.billRateCents;
        const cost = r.costRateCents;
        const marginPct = cost == null || bill <= 0 ? null : (bill - cost) / bill;
        return {
          appUserId: r.appUserId,
          fullName: r.fullName,
          billCents: bill,
          costCents: cost,
          marginPct,
          effectiveStart: r.effectiveDate,
        };
      });
      res.json({ items });
    },
  );

  // -----------------------------------------------------------------
  // client-override / engagement-override / service-line — unchanged
  // -----------------------------------------------------------------
  router.post(
    '/client-override',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const parsed = ClientOverrideSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(clientRateOverrides)
        .values({
          clientId: parsed.data.clientId,
          appUserId: parsed.data.appUserId,
          billRateCents: parsed.data.billRateCents,
          effectiveStart: parsed.data.effectiveStart,
          effectiveEnd: parsed.data.effectiveEnd ?? null,
        })
        .returning({ id: clientRateOverrides.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_rate_override',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.delete(
    '/client-override/:id',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .select({ id: clientRateOverrides.id, clientId: clientRateOverrides.clientId })
        .from(clientRateOverrides)
        .innerJoin(clients, eq(clients.id, clientRateOverrides.clientId))
        .where(
          and(eq(clientRateOverrides.id, req.params['id']!), eq(clients.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db.delete(clientRateOverrides).where(eq(clientRateOverrides.id, row.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_rate_override',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { deleted: true },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/engagement-override',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const parsed = EngagementOverrideSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [eng] = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(eq(engagements.id, parsed.data.engagementId), eq(clients.firmId, session.firmId)),
        )
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(engagementRateOverrides)
        .values({
          engagementId: parsed.data.engagementId,
          appUserId: parsed.data.appUserId,
          billRateCents: parsed.data.billRateCents,
          effectiveStart: parsed.data.effectiveStart,
        })
        .returning({ id: engagementRateOverrides.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_rate_override',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.delete(
    '/engagement-override/:id',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .select({ id: engagementRateOverrides.id })
        .from(engagementRateOverrides)
        .innerJoin(engagements, eq(engagements.id, engagementRateOverrides.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(
            eq(engagementRateOverrides.id, req.params['id']!),
            eq(clients.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db.delete(engagementRateOverrides).where(eq(engagementRateOverrides.id, row.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'engagement_rate_override',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { deleted: true },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/service-line',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const parsed = ServiceLineRateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [sl] = await deps.db
        .select({ id: serviceLines.id })
        .from(serviceLines)
        .where(
          and(
            eq(serviceLines.id, parsed.data.serviceLineId),
            eq(serviceLines.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!sl) {
        res.status(404).json({ error: 'service_line_not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(serviceLineRates)
        .values({
          serviceLineId: parsed.data.serviceLineId,
          roleId: parsed.data.roleId,
          billRateCents: parsed.data.billRateCents,
          effectiveStart: parsed.data.effectiveStart,
          effectiveEnd: parsed.data.effectiveEnd ?? null,
        })
        .returning({ id: serviceLineRates.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'service_line_rate',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/service-line/:id',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .select({ id: serviceLineRates.id })
        .from(serviceLineRates)
        .innerJoin(serviceLines, eq(serviceLines.id, serviceLineRates.serviceLineId))
        .where(
          and(eq(serviceLineRates.id, req.params['id']!), eq(serviceLines.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const body = req.body as { billRateCents?: unknown; effectiveEnd?: unknown };
      const patch: Record<string, unknown> = {};
      if (typeof body.billRateCents === 'number' && body.billRateCents > 0) {
        patch['billRateCents'] = body.billRateCents;
      }
      if (typeof body.effectiveEnd === 'string' && DATE_RE.test(body.effectiveEnd)) {
        patch['effectiveEnd'] = body.effectiveEnd;
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db.update(serviceLineRates).set(patch).where(eq(serviceLineRates.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'service_line_rate',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: patch,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.delete(
    '/service-line/:id',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .select({ id: serviceLineRates.id })
        .from(serviceLineRates)
        .innerJoin(serviceLines, eq(serviceLines.id, serviceLineRates.serviceLineId))
        .where(
          and(eq(serviceLineRates.id, req.params['id']!), eq(serviceLines.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db.delete(serviceLineRates).where(eq(serviceLineRates.id, row.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'service_line_rate',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { deleted: true },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // -----------------------------------------------------------------
  // GET /resolve-debug — replays resolver for (user, engagement, date)
  // -----------------------------------------------------------------
  router.get(
    '/resolve-debug',
    requirePermission(deps, 'rate:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ resolved: null, candidates: [], engagement: null });
        return;
      }
      const appUserId = uuidQueryParam(req.query['appUserId']);
      const engagementId = uuidQueryParam(req.query['engagementId']);
      const serviceDate = String(req.query['serviceDate'] ?? '');
      if (appUserId === 'invalid' || engagementId === 'invalid') {
        res.status(400).json({ error: 'invalid_uuid_param' });
        return;
      }
      if (!appUserId || !engagementId || !DATE_RE.test(serviceDate)) {
        res.status(400).json({ error: 'appUserId_engagementId_serviceDate_required' });
        return;
      }
      const [user] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, appUserId), eq(appUsers.firmId, session.firmId)))
        .limit(1);
      if (!user) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }
      const [eng] = await deps.db
        .select({
          id: engagements.id,
          clientId: engagements.clientId,
          name: engagements.name,
          rateMultiplierBps: engagements.rateMultiplierBps,
          defaultRateCodeId: engagements.defaultRateCodeId,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(engagements.id, engagementId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }

      const candidates: RateCandidate[] = [];
      const snap = await deps.db
        .select({
          effectiveDate: staffRateSnapshots.effectiveDate,
          costRateCents: staffRateSnapshots.costRateCents,
          rateCodeId: staffRateSnapshotEntries.rateCodeId,
          billRateCents: staffRateSnapshotEntries.billRateCents,
          code: rateCodes.code,
        })
        .from(staffRateSnapshots)
        .innerJoin(
          staffRateSnapshotEntries,
          eq(staffRateSnapshotEntries.snapshotId, staffRateSnapshots.id),
        )
        .innerJoin(rateCodes, eq(rateCodes.id, staffRateSnapshotEntries.rateCodeId))
        .where(
          and(eq(staffRateSnapshots.appUserId, appUserId), eq(rateCodes.firmId, session.firmId)),
        );
      for (const r of snap) {
        candidates.push({
          level: 'staff_rate',
          appUserId,
          rateCodeId: r.rateCodeId,
          isStandardCode: r.code === 'StandardRate',
          billRateCents: r.billRateCents,
          costRateCents: r.costRateCents ?? null,
          effectiveStart: r.effectiveDate,
          effectiveEnd: null,
        });
      }
      const cl = await deps.db
        .select()
        .from(clientRateOverrides)
        .where(
          and(
            eq(clientRateOverrides.clientId, eng.clientId),
            eq(clientRateOverrides.appUserId, appUserId),
          ),
        );
      for (const r of cl) {
        candidates.push({
          level: 'client',
          clientId: eng.clientId,
          appUserId,
          billRateCents: r.billRateCents,
          effectiveStart: r.effectiveStart,
          effectiveEnd: r.effectiveEnd ?? null,
        });
      }
      const engOv = await deps.db
        .select()
        .from(engagementRateOverrides)
        .where(
          and(
            eq(engagementRateOverrides.engagementId, engagementId),
            eq(engagementRateOverrides.appUserId, appUserId),
          ),
        );
      for (const r of engOv) {
        candidates.push({
          level: 'engagement',
          engagementId,
          appUserId,
          billRateCents: r.billRateCents,
          effectiveStart: r.effectiveStart,
        });
      }

      const resolved = resolveRate({
        serviceDate,
        appUserId,
        engagementId,
        clientId: eng.clientId,
        serviceLineId: null,
        rateCodeId: eng.defaultRateCodeId ?? null,
        candidates,
        firmDefaultBillRateCents: 0,
      });
      const multiplierBps = eng.rateMultiplierBps ?? 10000;
      const effectiveRateCents = Math.round((resolved.billRateCents * multiplierBps) / 10000);
      res.json({
        resolved,
        engagement: {
          id: eng.id,
          name: eng.name,
          rateMultiplierBps: multiplierBps,
          defaultRateCodeId: eng.defaultRateCodeId,
        },
        effectiveRateCents,
        candidates,
      });
    },
  );

  return router;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface CurrentStandardRow {
  appUserId: string;
  fullName: string;
  billRateCents: number;
  costRateCents: number | null;
  effectiveDate: string;
  standardRateCodeId: string;
}

async function currentStandardRateRows(
  db: Database,
  firmId: string,
): Promise<CurrentStandardRow[]> {
  // For each staff user, find the latest snapshot (effective_date <= today)
  // and its StandardRate entry. SQL-side via a window function would scale
  // better, but firms are small enough that a per-user lookup is fine.
  const today = new Date().toISOString().slice(0, 10);
  const users = await db
    .select({ id: appUsers.id, fullName: appUsers.fullName })
    .from(appUsers)
    .where(eq(appUsers.firmId, firmId));
  const [stdCode] = await db
    .select({ id: rateCodes.id })
    .from(rateCodes)
    .where(and(eq(rateCodes.firmId, firmId), eq(rateCodes.code, 'StandardRate')))
    .limit(1);
  if (!stdCode) return [];
  const out: CurrentStandardRow[] = [];
  for (const u of users) {
    const [snap] = await db
      .select({
        id: staffRateSnapshots.id,
        effectiveDate: staffRateSnapshots.effectiveDate,
        costRateCents: staffRateSnapshots.costRateCents,
      })
      .from(staffRateSnapshots)
      .where(
        and(
          eq(staffRateSnapshots.appUserId, u.id),
          sql`${staffRateSnapshots.effectiveDate} <= ${today}`,
        ),
      )
      .orderBy(desc(staffRateSnapshots.effectiveDate))
      .limit(1);
    if (!snap) continue;
    const [entry] = await db
      .select({ billRateCents: staffRateSnapshotEntries.billRateCents })
      .from(staffRateSnapshotEntries)
      .where(
        and(
          eq(staffRateSnapshotEntries.snapshotId, snap.id),
          eq(staffRateSnapshotEntries.rateCodeId, stdCode.id),
        ),
      )
      .limit(1);
    if (!entry) continue;
    out.push({
      appUserId: u.id,
      fullName: u.fullName,
      billRateCents: entry.billRateCents,
      costRateCents: snap.costRateCents ?? null,
      effectiveDate: snap.effectiveDate,
      standardRateCodeId: stdCode.id,
    });
  }
  return out;
}

/**
 * Append-only snapshot creation. When `entriesFromPrior` is true the new
 * snapshot copies forward every entry from the immediately-prior snapshot
 * for this user, with the StandardRate entry overridden by
 * `standardBillRateCents`. Used by bulk-update.
 *
 * For the regular per-user snapshot create flow (UserDetail UI), pass
 * `entries` directly and leave `entriesFromPrior=false`.
 */
export async function createSnapshot(
  db: Database,
  args: {
    appUserId: string;
    effectiveDate: string;
    costRateCents: number | null;
    entries?: { rateCodeId: string; billRateCents: number }[];
    entriesFromPrior?: boolean;
    standardRateCodeId?: string;
    standardBillRateCents?: number;
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [snap] = await tx
      .insert(staffRateSnapshots)
      .values({
        appUserId: args.appUserId,
        effectiveDate: args.effectiveDate,
        costRateCents: args.costRateCents,
      })
      .returning({ id: staffRateSnapshots.id });
    if (!snap) throw new Error('snapshot_insert_failed');
    let entries = args.entries ?? [];
    if (args.entriesFromPrior) {
      const prior = await tx
        .select({
          id: staffRateSnapshots.id,
        })
        .from(staffRateSnapshots)
        .where(
          and(
            eq(staffRateSnapshots.appUserId, args.appUserId),
            sql`${staffRateSnapshots.effectiveDate} < ${args.effectiveDate}`,
          ),
        )
        .orderBy(desc(staffRateSnapshots.effectiveDate))
        .limit(1);
      const priorId = prior[0]?.id;
      if (priorId) {
        const priorEntries = await tx
          .select({
            rateCodeId: staffRateSnapshotEntries.rateCodeId,
            billRateCents: staffRateSnapshotEntries.billRateCents,
          })
          .from(staffRateSnapshotEntries)
          .where(eq(staffRateSnapshotEntries.snapshotId, priorId));
        entries = priorEntries.map((e) =>
          args.standardRateCodeId === e.rateCodeId && args.standardBillRateCents != null
            ? { rateCodeId: e.rateCodeId, billRateCents: args.standardBillRateCents }
            : e,
        );
      } else if (args.standardRateCodeId && args.standardBillRateCents != null) {
        entries = [
          { rateCodeId: args.standardRateCodeId, billRateCents: args.standardBillRateCents },
        ];
      }
    }
    if (entries.length > 0) {
      await tx.insert(staffRateSnapshotEntries).values(
        entries.map((e) => ({
          snapshotId: snap.id,
          rateCodeId: e.rateCodeId,
          billRateCents: e.billRateCents,
        })),
      );
    }
    return snap.id;
  });
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
