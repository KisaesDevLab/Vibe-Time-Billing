// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Rate management endpoints (Phase 7). The effective-dated history view
// lets staff see every rate that resolved for a given timekeeper over
// time — useful for audit/reconciliation of historical invoices.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';

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

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TimekeeperRateSchema = z.object({
  appUserId: z.string().uuid(),
  billRateCents: z.number().int().positive(),
  costRateCents: z.number().int().nonnegative().optional(),
  effectiveStart: z.string().regex(DATE_RE),
});

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

  router.post(
    '/timekeeper',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const parsed = TimekeeperRateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [user] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, parsed.data.appUserId), eq(appUsers.firmId, session.firmId)))
        .limit(1);
      if (!user) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }
      const newId = await deps.db.transaction(async (tx) => {
        // Cap the prior open-ended rate (effective_end is NULL) at the day
        // before the new effective_start.
        const dayBefore = new Date(
          Date.parse(parsed.data.effectiveStart + 'T00:00:00Z') - 86_400_000,
        )
          .toISOString()
          .slice(0, 10);
        await tx
          .update(timekeeperRates)
          .set({ effectiveEnd: dayBefore })
          .where(
            and(
              eq(timekeeperRates.appUserId, parsed.data.appUserId),
              isNull(timekeeperRates.effectiveEnd),
            ),
          );
        const [row] = await tx
          .insert(timekeeperRates)
          .values({
            appUserId: parsed.data.appUserId,
            billRateCents: parsed.data.billRateCents,
            costRateCents: parsed.data.costRateCents ?? null,
            effectiveStart: parsed.data.effectiveStart,
          })
          .returning({ id: timekeeperRates.id });
        return row?.id;
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'timekeeper_rate',
        entityId: newId,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: newId });
    },
  );

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
      // Scope: client must belong to firm.
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
      const effectiveStart = typeof body.effectiveStart === 'string' ? body.effectiveStart : null;
      if (!Number.isFinite(pct) || !effectiveStart || !DATE_RE.test(effectiveStart)) {
        res.status(400).json({ error: 'pct_change_and_effective_start_required' });
        return;
      }
      const userIdFilter = Array.isArray(body.appUserIds)
        ? body.appUserIds.filter((x): x is string => typeof x === 'string')
        : null;
      const users = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(eq(appUsers.firmId, session.firmId));
      const inScope = users
        .map((u) => u.id)
        .filter((id) => !userIdFilter || userIdFilter.includes(id));
      const dayBefore = new Date(Date.parse(effectiveStart + 'T00:00:00Z') - 86_400_000)
        .toISOString()
        .slice(0, 10);
      let updated = 0;
      for (const userId of inScope) {
        const [current] = await deps.db
          .select()
          .from(timekeeperRates)
          .where(and(eq(timekeeperRates.appUserId, userId), isNull(timekeeperRates.effectiveEnd)))
          .orderBy(desc(timekeeperRates.effectiveStart))
          .limit(1);
        if (!current) continue;
        const newRate = Math.round(Number(current.billRateCents) * (1 + pct / 100));
        await deps.db.transaction(async (tx) => {
          await tx
            .update(timekeeperRates)
            .set({ effectiveEnd: dayBefore })
            .where(eq(timekeeperRates.id, current.id));
          await tx.insert(timekeeperRates).values({
            appUserId: userId,
            billRateCents: newRate,
            costRateCents: current.costRateCents ?? null,
            effectiveStart,
          });
        });
        updated++;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'timekeeper_rate',
        actorAppUserId: session.appUserId,
        after: { kind: 'bulk_update', pctChange: pct, effectiveStart, updated },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, updated });
    },
  );

  router.get(
    '/loaded-margin',
    requirePermission(deps, 'rate:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      // Loaded margin = (bill - cost) / bill for the current open-ended
      // timekeeper rate. We list every staff user with both rates set.
      const rows = await deps.db
        .select({
          appUserId: appUsers.id,
          fullName: appUsers.fullName,
          billCents: timekeeperRates.billRateCents,
          costCents: timekeeperRates.costRateCents,
          effectiveStart: timekeeperRates.effectiveStart,
        })
        .from(timekeeperRates)
        .innerJoin(appUsers, eq(appUsers.id, timekeeperRates.appUserId))
        .where(and(eq(appUsers.firmId, session.firmId), isNull(timekeeperRates.effectiveEnd)));
      const items = rows.map((r) => {
        const bill = Number(r.billCents ?? 0);
        const cost = r.costCents == null ? null : Number(r.costCents);
        const marginPct = cost == null || bill <= 0 ? null : (bill - cost) / bill;
        return {
          appUserId: r.appUserId,
          fullName: r.fullName,
          billCents: bill,
          costCents: cost,
          marginPct,
          effectiveStart: r.effectiveStart,
        };
      });
      res.json({ items });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

// Silence unused-import warnings — `or`, `sql` are used in future filters.
void or;
void sql;
