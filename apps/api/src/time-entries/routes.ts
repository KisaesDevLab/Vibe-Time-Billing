// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Time entry capture (Phase 9). Captures the rate snapshot at create time
// using @vibe/core/rates resolver, then writes the canonical row.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import {
  clientRateOverrides,
  clients,
  engagementRateOverrides,
  engagements,
  firms,
  serviceLineRates,
  timeEntries,
  timeEntryVersions,
  timekeeperRates,
  workCodes,
} from '@vibe/db/schema';
import { captureRateSnapshot, resolveRate, type RateCandidate } from '@vibe/core/rates';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface TimeEntryRoutesDeps extends RbacDeps {
  db: Database | null;
  redis?: Redis;
}

const TIMER_KEY_PREFIX = 'time-entry:timer:';
function timerKey(appUserId: string): string {
  return `${TIMER_KEY_PREFIX}${appUserId}`;
}

const TimerStartSchema = z.object({
  engagementId: z.string().uuid(),
  workCodeId: z.string().uuid().optional(),
  description: z.string().max(2000).optional(),
});

const CreateSchema = z.object({
  engagementId: z.string().uuid(),
  workCodeId: z.string().uuid().optional(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours: z.number().positive().max(24),
  billableFlag: z.boolean().optional(),
  description: z.string().max(2000).optional(),
});

const UpdateSchema = z.object({
  hours: z.number().positive().max(24).optional(),
  workCodeId: z.string().uuid().nullable().optional(),
  description: z.string().max(2000).optional(),
  billableFlag: z.boolean().optional(),
});

const BulkFromTemplateSchema = z.object({
  template: z.object({
    engagementId: z.string().uuid(),
    workCodeId: z.string().uuid().optional(),
    hours: z.number().positive().max(24),
    description: z.string().max(2000).optional(),
    billableFlag: z.boolean().optional(),
  }),
  dates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .min(1)
    .max(60),
});

async function loadRateCandidates(
  db: Database,
  args: { appUserId: string; engagementId: string; clientId: string; serviceLineId: string | null },
): Promise<RateCandidate[]> {
  const out: RateCandidate[] = [];

  const tk = await db
    .select()
    .from(timekeeperRates)
    .where(eq(timekeeperRates.appUserId, args.appUserId));
  for (const r of tk) {
    out.push({
      level: 'timekeeper',
      appUserId: args.appUserId,
      billRateCents: r.billRateCents,
      costRateCents: r.costRateCents ?? null,
      effectiveStart: r.effectiveStart,
      effectiveEnd: r.effectiveEnd ?? null,
    });
  }

  const cl = await db
    .select()
    .from(clientRateOverrides)
    .where(
      and(
        eq(clientRateOverrides.clientId, args.clientId),
        eq(clientRateOverrides.appUserId, args.appUserId),
      ),
    );
  for (const r of cl) {
    out.push({
      level: 'client',
      clientId: args.clientId,
      appUserId: args.appUserId,
      billRateCents: r.billRateCents,
      effectiveStart: r.effectiveStart,
      effectiveEnd: r.effectiveEnd ?? null,
    });
  }

  const eng = await db
    .select()
    .from(engagementRateOverrides)
    .where(
      and(
        eq(engagementRateOverrides.engagementId, args.engagementId),
        eq(engagementRateOverrides.appUserId, args.appUserId),
      ),
    );
  for (const r of eng) {
    out.push({
      level: 'engagement',
      engagementId: args.engagementId,
      appUserId: args.appUserId,
      billRateCents: r.billRateCents,
      effectiveStart: r.effectiveStart,
    });
  }

  if (args.serviceLineId) {
    const sl = await db
      .select()
      .from(serviceLineRates)
      .where(eq(serviceLineRates.serviceLineId, args.serviceLineId));
    for (const r of sl) {
      out.push({
        level: 'service_line',
        serviceLineId: args.serviceLineId,
        appUserId: args.appUserId,
        billRateCents: r.billRateCents,
        effectiveStart: r.effectiveStart,
        effectiveEnd: r.effectiveEnd ?? null,
      });
    }
  }

  return out;
}

export function createTimeEntryRouter(deps: TimeEntryRoutesDeps): Router {
  const router = express.Router();

  router.post(
    '/',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }

      // Resolve engagement → client → service line
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, parsed.data.engagementId))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      // Lifecycle enforcement: PAUSED engagements cannot accept new time.
      if (eng.status === 'PAUSED' || eng.status === 'CLOSED' || eng.status === 'ARCHIVED') {
        res.status(409).json({ error: 'engagement_not_writable', status: eng.status });
        return;
      }
      const [client] = await deps.db
        .select()
        .from(clients)
        .where(eq(clients.id, eng.clientId))
        .limit(1);
      if (!client || client.firmId !== session.firmId) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      let serviceLineId: string | null = null;
      if (parsed.data.workCodeId) {
        const [wc] = await deps.db
          .select({ serviceLineId: workCodes.serviceLineId })
          .from(workCodes)
          .where(eq(workCodes.id, parsed.data.workCodeId))
          .limit(1);
        serviceLineId = wc?.serviceLineId ?? null;
      }

      const candidates = await loadRateCandidates(deps.db, {
        appUserId: session.appUserId,
        engagementId: eng.id,
        clientId: client.id,
        serviceLineId,
      });

      const [firm] = await deps.db
        .select({ id: firms.id })
        .from(firms)
        .where(eq(firms.id, session.firmId))
        .limit(1);
      if (!firm) {
        res.status(500).json({ error: 'firm_not_found' });
        return;
      }
      // Firm default bill rate isn't on the schema (deliberately — every
      // staff user has a timekeeper rate). We fall back to a sentinel 0
      // if nothing resolves; the API should never store that, so we
      // refuse the entry.
      const resolved = resolveRate({
        serviceDate: parsed.data.entryDate,
        appUserId: session.appUserId,
        engagementId: eng.id,
        clientId: client.id,
        serviceLineId,
        candidates,
        firmDefaultBillRateCents: 0,
      });
      if (resolved.level === 'firm' && resolved.billRateCents === 0) {
        res.status(400).json({ error: 'no_rate_resolves', userId: session.appUserId });
        return;
      }
      const snapshot = captureRateSnapshot({ rate: resolved, hours: parsed.data.hours });

      // NTE cap (Phase 10 #19): if the engagement has nte_cap_cents set,
      // reject when this entry would push the running standard-amount
      // total past the cap. LIFETIME scope is enforced across all entries;
      // PERIOD scope uses the calendar month containing entryDate.
      if (eng.nteCapCents != null && Number(eng.nteCapCents) > 0) {
        const monthStart = parsed.data.entryDate.slice(0, 7) + '-01';
        const nextMonth = new Date(monthStart + 'T00:00:00Z');
        nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
        const monthEnd = nextMonth.toISOString().slice(0, 10);
        const conds = [
          eq(timeEntries.engagementId, eng.id),
          inArray(timeEntries.status, ['SUBMITTED', 'LOCKED', 'BILLED']),
        ];
        if (eng.nteCapScope === 'PERIOD') {
          conds.push(gte(timeEntries.entryDate, monthStart));
          conds.push(lte(timeEntries.entryDate, monthEnd));
        }
        const [accum] = await deps.db
          .select({
            total: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as('total'),
          })
          .from(timeEntries)
          .where(and(...conds));
        const projected = Number(accum?.total ?? 0) + snapshot.amountCents;
        if (projected > Number(eng.nteCapCents)) {
          res.status(409).json({
            error: 'nte_cap_exceeded',
            capCents: Number(eng.nteCapCents),
            projectedCents: projected,
          });
          return;
        }
      }

      // Q20 — in_scope flag set at write time from engagement's array
      const inScope =
        eng.mixedModeEnabled && parsed.data.workCodeId
          ? eng.inScopeWorkCodeIds.includes(parsed.data.workCodeId)
          : true;

      const [row] = await deps.db
        .insert(timeEntries)
        .values({
          engagementId: eng.id,
          appUserId: session.appUserId,
          workCodeId: parsed.data.workCodeId ?? null,
          entryDate: parsed.data.entryDate,
          hours: parsed.data.hours.toString(),
          billableFlag: parsed.data.billableFlag ?? true,
          inScopeFlag: inScope,
          description: parsed.data.description ?? '',
          standardRateSnapshotCents: snapshot.rateCents,
          standardAmountCents: snapshot.amountCents,
        })
        .returning({ id: timeEntries.id });

      res.status(201).json({
        id: row?.id,
        rateSnapshot: snapshot.rateCents,
        amount: snapshot.amountCents,
        resolutionLevel: resolved.level,
      });
    },
  );

  router.get(
    '/export.csv',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.send('id,appUserId,entryDate,hours,amountCents\n');
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      const clientIds = firmClients.map((c) => c.id);
      if (clientIds.length === 0) {
        res.send('id,appUserId,entryDate,hours,amountCents\n');
        return;
      }
      const engs = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(inArray(engagements.clientId, clientIds));
      const engIds = engs.map((e) => e.id);
      const conds = [inArray(timeEntries.engagementId, engIds)];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      const items = engIds.length
        ? await deps.db
            .select()
            .from(timeEntries)
            .where(and(...conds))
            .limit(20000)
        : [];
      const header = [
        'id',
        'appUserId',
        'engagementId',
        'entryDate',
        'hours',
        'rateCents',
        'amountCents',
        'billable',
        'inScope',
        'status',
      ];
      const lines = [header.join(',')];
      for (const t of items) {
        lines.push(
          [
            t.id,
            t.appUserId,
            t.engagementId,
            t.entryDate,
            t.hours,
            t.standardRateSnapshotCents,
            t.standardAmountCents,
            String(t.billableFlag),
            String(t.inScopeFlag),
            t.status,
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="time-entries-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(lines.join('\n') + '\n');
    },
  );

  router.get(
    '/by-engagement/:engagementId',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      // Scope: engagement must belong to firm.
      const [scope] = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(eq(engagements.id, req.params['engagementId']!), eq(clients.firmId, session.firmId)),
        )
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const conds = [eq(timeEntries.engagementId, req.params['engagementId']!)];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      const items = await deps.db
        .select()
        .from(timeEntries)
        .where(and(...conds))
        .limit(1000);
      res.json({ items });
    },
  );

  router.get(
    '/by-client/:clientId',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, req.params['clientId']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const engIds = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.clientId, req.params['clientId']!));
      const ids = engIds.map((e) => e.id);
      if (ids.length === 0) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(timeEntries)
        .where(inArray(timeEntries.engagementId, ids))
        .limit(1000);
      res.json({ items });
    },
  );

  router.post(
    '/:id/submit',
    requirePermission(deps, 'time_entry:update:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.id, req.params['id']!))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.appUserId !== session.appUserId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (prior.status !== 'DRAFT') {
        res.status(409).json({ error: 'not_draft', status: prior.status });
        return;
      }
      await deps.db
        .update(timeEntries)
        .set({ status: 'SUBMITTED' })
        .where(eq(timeEntries.id, prior.id));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/lock',
    requirePermission(deps, 'time_entry:update:any'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(timeEntries)
        .set({ status: 'LOCKED', lockedAt: new Date() })
        .where(eq(timeEntries.id, req.params['id']!));
      res.json({ ok: true });
    },
  );

  router.get(
    '/mine',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const conds = [eq(timeEntries.appUserId, session.appUserId)];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      const items = await deps.db
        .select()
        .from(timeEntries)
        .where(and(...conds))
        .limit(500);
      res.json({ items });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'time_entry:update:own'),
    async (req: Request, res: Response) => {
      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      // Version-stamp the prior shape (immutability of past values).
      const [prior] = await deps.db
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.id, req.params['id']!))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.appUserId !== session.appUserId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (prior.lockedAt) {
        res.status(409).json({ error: 'locked' });
        return;
      }

      const [maxVersion] = await deps.db
        .select({ v: timeEntryVersions.version })
        .from(timeEntryVersions)
        .where(eq(timeEntryVersions.timeEntryId, prior.id))
        .orderBy(timeEntryVersions.version)
        .limit(1);
      const nextVersion = (maxVersion?.v ?? 0) + 1;
      await deps.db.insert(timeEntryVersions).values({
        timeEntryId: prior.id,
        version: nextVersion,
        fields: prior,
        editedById: session.appUserId,
      });

      // Rate snapshot does NOT change on edit; only mutable fields update.
      const patch: Record<string, unknown> = {};
      if (parsed.data.hours != null) {
        patch['hours'] = parsed.data.hours.toString();
        patch['standardAmountCents'] = Math.round(
          prior.standardRateSnapshotCents * parsed.data.hours,
        );
      }
      if (parsed.data.workCodeId !== undefined) patch['workCodeId'] = parsed.data.workCodeId;
      if (parsed.data.description !== undefined) patch['description'] = parsed.data.description;
      if (parsed.data.billableFlag !== undefined) patch['billableFlag'] = parsed.data.billableFlag;

      await deps.db.update(timeEntries).set(patch).where(eq(timeEntries.id, prior.id));
      res.json({ ok: true, version: nextVersion });
    },
  );

  router.post(
    '/bulk-from-template',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const parsed = BulkFromTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true, created: 0 });
        return;
      }
      const t = parsed.data.template;
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, t.engagementId))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const [client] = await deps.db
        .select()
        .from(clients)
        .where(eq(clients.id, eng.clientId))
        .limit(1);
      if (!client || client.firmId !== session.firmId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      let serviceLineId: string | null = null;
      if (t.workCodeId) {
        const [wc] = await deps.db
          .select({ serviceLineId: workCodes.serviceLineId })
          .from(workCodes)
          .where(eq(workCodes.id, t.workCodeId))
          .limit(1);
        serviceLineId = wc?.serviceLineId ?? null;
      }
      const candidates = await loadRateCandidates(deps.db, {
        appUserId: session.appUserId,
        engagementId: eng.id,
        clientId: client.id,
        serviceLineId,
      });
      const inScope =
        eng.mixedModeEnabled && t.workCodeId ? eng.inScopeWorkCodeIds.includes(t.workCodeId) : true;
      const rows: (typeof timeEntries.$inferInsert)[] = [];
      for (const date of parsed.data.dates) {
        const resolved = resolveRate({
          serviceDate: date,
          appUserId: session.appUserId,
          engagementId: eng.id,
          clientId: client.id,
          serviceLineId,
          candidates,
          firmDefaultBillRateCents: 0,
        });
        if (resolved.level === 'firm' && resolved.billRateCents === 0) {
          res.status(400).json({ error: 'no_rate_resolves', forDate: date });
          return;
        }
        const snapshot = captureRateSnapshot({ rate: resolved, hours: t.hours });
        rows.push({
          engagementId: eng.id,
          appUserId: session.appUserId,
          workCodeId: t.workCodeId ?? null,
          entryDate: date,
          hours: t.hours.toString(),
          billableFlag: t.billableFlag ?? true,
          inScopeFlag: inScope,
          description: t.description ?? '',
          standardRateSnapshotCents: snapshot.rateCents,
          standardAmountCents: snapshot.amountCents,
        });
      }
      const inserted = await deps.db
        .insert(timeEntries)
        .values(rows)
        .returning({ id: timeEntries.id });
      res.status(201).json({ ok: true, created: inserted.length, ids: inserted.map((r) => r.id) });
    },
  );

  router.post(
    '/:id/transfer',
    requirePermission(deps, 'time_entry:update:any'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const toEngagementId =
        typeof req.body?.engagementId === 'string' ? req.body.engagementId : null;
      if (!toEngagementId) {
        res.status(400).json({ error: 'engagement_id_required' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.id, req.params['id']!))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.lockedAt || prior.status === 'BILLED') {
        res.status(409).json({ error: 'locked' });
        return;
      }
      // Validate the target engagement belongs to the same firm.
      const [target] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, toEngagementId))
        .limit(1);
      if (!target) {
        res.status(404).json({ error: 'target_engagement_not_found' });
        return;
      }
      const [targetClient] = await deps.db
        .select({ firmId: clients.firmId })
        .from(clients)
        .where(eq(clients.id, target.clientId))
        .limit(1);
      if (!targetClient || targetClient.firmId !== session.firmId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const [maxVersion] = await deps.db
        .select({ v: timeEntryVersions.version })
        .from(timeEntryVersions)
        .where(eq(timeEntryVersions.timeEntryId, prior.id))
        .orderBy(timeEntryVersions.version)
        .limit(1);
      const nextVersion = (maxVersion?.v ?? 0) + 1;
      await deps.db.insert(timeEntryVersions).values({
        timeEntryId: prior.id,
        version: nextVersion,
        fields: prior,
        editedById: session.appUserId,
      });
      await deps.db
        .update(timeEntries)
        .set({ engagementId: toEngagementId })
        .where(eq(timeEntries.id, prior.id));
      res.json({ ok: true });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'time_entry:update:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.id, req.params['id']!))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.appUserId !== session.appUserId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (prior.lockedAt || prior.status === 'BILLED' || prior.status === 'LOCKED') {
        res.status(409).json({ error: 'locked' });
        return;
      }
      const [maxVersion] = await deps.db
        .select({ v: timeEntryVersions.version })
        .from(timeEntryVersions)
        .where(eq(timeEntryVersions.timeEntryId, prior.id))
        .orderBy(timeEntryVersions.version)
        .limit(1);
      const nextVersion = (maxVersion?.v ?? 0) + 1;
      await deps.db.insert(timeEntryVersions).values({
        timeEntryId: prior.id,
        version: nextVersion,
        fields: prior,
        editedById: session.appUserId,
      });
      await deps.db
        .update(timeEntries)
        .set({ status: 'ARCHIVED' })
        .where(eq(timeEntries.id, prior.id));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/write-off',
    requirePermission(deps, 'time_entry:update:any'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(timeEntries)
        .set({ status: 'WRITTEN_OFF' })
        .where(eq(timeEntries.id, req.params['id']!));
      res.json({ ok: true });
    },
  );

  router.get(
    '/by-status/:status',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const status = req.params['status']!;
      const allowed = ['DRAFT', 'SUBMITTED', 'LOCKED', 'BILLED', 'WRITTEN_OFF', 'ARCHIVED'];
      if (!allowed.includes(status)) {
        res.status(400).json({ error: 'invalid_status' });
        return;
      }
      // Scope to firm via engagement->client join.
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      const firmClientIds = firmClients.map((c) => c.id);
      if (firmClientIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const firmEngs = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(inArray(engagements.clientId, firmClientIds));
      const engIds = firmEngs.map((e) => e.id);
      if (engIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(timeEntries)
        .where(
          and(
            inArray(timeEntries.engagementId, engIds),
            eq(
              timeEntries.status,
              status as 'DRAFT' | 'SUBMITTED' | 'LOCKED' | 'BILLED' | 'WRITTEN_OFF' | 'ARCHIVED',
            ),
          ),
        )
        .limit(1000);
      res.json({ items });
    },
  );

  router.post(
    '/timer/start',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const parsed = TimerStartSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.redis) {
        res.status(503).json({ error: 'no_redis' });
        return;
      }
      const existing = await deps.redis.get(timerKey(session.appUserId));
      if (existing) {
        res.status(409).json({ error: 'timer_already_running', state: JSON.parse(existing) });
        return;
      }
      const state = {
        engagementId: parsed.data.engagementId,
        workCodeId: parsed.data.workCodeId ?? null,
        description: parsed.data.description ?? '',
        startedAt: new Date().toISOString(),
      };
      // 24h TTL guards against orphaned timers.
      await deps.redis.set(timerKey(session.appUserId), JSON.stringify(state), 'EX', 24 * 3600);
      res.status(201).json({ ok: true, state });
    },
  );

  router.get(
    '/timer/status',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.redis) {
        res.json({ running: false });
        return;
      }
      const v = await deps.redis.get(timerKey(session.appUserId));
      if (!v) {
        res.json({ running: false });
        return;
      }
      const state = JSON.parse(v) as { startedAt: string; engagementId: string };
      const elapsedMs = Date.now() - Date.parse(state.startedAt);
      res.json({ running: true, state, elapsedMs });
    },
  );

  router.post(
    '/timer/stop',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.redis) {
        res.status(503).json({ error: 'no_redis' });
        return;
      }
      const v = await deps.redis.get(timerKey(session.appUserId));
      if (!v) {
        res.status(404).json({ error: 'no_timer_running' });
        return;
      }
      const state = JSON.parse(v) as {
        engagementId: string;
        workCodeId: string | null;
        description: string;
        startedAt: string;
      };
      const elapsedMs = Date.now() - Date.parse(state.startedAt);
      const elapsedHours = elapsedMs / 3_600_000;
      // Round to 0.25h per Q19 default.
      const rounded = Math.max(0.25, Math.round(elapsedHours / 0.25) * 0.25);
      await deps.redis.del(timerKey(session.appUserId));
      res.json({
        ok: true,
        engagementId: state.engagementId,
        workCodeId: state.workCodeId,
        description: state.description,
        elapsedHours: rounded,
        startedAt: state.startedAt,
      });
    },
  );

  router.get(
    '/totals/firm/by-user',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const conds = [];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      // Scope to firm via app_user join.
      const userIds = (
        await deps.db.select({ id: firms.id }).from(firms).where(eq(firms.id, session.firmId))
      ).length
        ? (
            await deps.db
              .select({ id: sql<string>`app_user.id`.as('id') })
              .from(sql`app_user`)
              .where(sql`app_user.firm_id = ${session.firmId}`)
          ).map((r) => r.id as string)
        : [];
      if (userIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const allConds = [...conds, inArray(timeEntries.appUserId, userIds)];
      const rows = await deps.db
        .select({
          appUserId: timeEntries.appUserId,
          hours: sql<string>`SUM(${timeEntries.hours})`.as('hours'),
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as(
            'amountCents',
          ),
        })
        .from(timeEntries)
        .where(and(...allConds))
        .groupBy(timeEntries.appUserId);
      res.json({
        items: rows.map((r) => ({
          appUserId: r.appUserId,
          hours: Number(r.hours),
          amountCents: Number(r.amountCents),
        })),
      });
    },
  );

  router.get(
    '/totals/by-day',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const conds = [eq(timeEntries.appUserId, session.appUserId)];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      const rows = await deps.db
        .select({
          entryDate: timeEntries.entryDate,
          hours: sql<string>`SUM(${timeEntries.hours})`.as('hours'),
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as(
            'amountCents',
          ),
        })
        .from(timeEntries)
        .where(and(...conds))
        .groupBy(timeEntries.entryDate)
        .orderBy(timeEntries.entryDate);
      res.json({
        items: rows.map((r) => ({
          entryDate: r.entryDate,
          hours: Number(r.hours),
          amountCents: Number(r.amountCents),
        })),
      });
    },
  );

  router.get(
    '/totals/by-week',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const conds = [eq(timeEntries.appUserId, session.appUserId)];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      const weekStart = sql<string>`to_char(date_trunc('week', ${timeEntries.entryDate})::date, 'YYYY-MM-DD')`;
      const rows = await deps.db
        .select({
          weekStart: weekStart.as('weekStart'),
          hours: sql<string>`SUM(${timeEntries.hours})`.as('hours'),
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as(
            'amountCents',
          ),
        })
        .from(timeEntries)
        .where(and(...conds))
        .groupBy(weekStart)
        .orderBy(weekStart);
      res.json({
        items: rows.map((r) => ({
          weekStart: r.weekStart,
          hours: Number(r.hours),
          amountCents: Number(r.amountCents),
        })),
      });
    },
  );

  return router;
}
