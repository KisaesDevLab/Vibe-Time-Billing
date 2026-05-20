// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Time entry capture (Phase 9). Captures the rate snapshot at create time
// using @vibe/core/rates resolver, then writes the canonical row.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, gte, lte } from 'drizzle-orm';

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
}

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

  return router;
}
