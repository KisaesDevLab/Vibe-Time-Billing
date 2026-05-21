// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Billing batch (pre-bill) endpoints — Phase 11. Creates a batch over
// the engagement's unbilled time entries in a period, links each entry
// via billing_batch_entry, and assigns the batch to those entries.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, between, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  billingBatchEntries,
  billingBatches,
  clients,
  engagements,
  timeEntries,
} from '@vibe/db/schema';
import { applyEntryAction, bucketize, type EntryAction } from '@vibe/core/billing';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface BillingBatchRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CreateSchema = z.object({
  engagementId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const EntryActionSchema = z.object({
  timeEntryId: z.string().uuid(),
  action: z.enum(['INCLUDE', 'DEFER', 'WRITE_OFF', 'WRITE_OFF_HELD']),
  comment: z.string().max(500).optional(),
});

const FinalizeSchema = z.object({
  actions: z.array(EntryActionSchema).min(1).max(5000),
});

export function createBillingBatchRouter(deps: BillingBatchRoutesDeps): Router {
  const router = express.Router();

  router.post(
    '/',
    requirePermission(deps, 'billing_batch:write'),
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
        .select({ firmId: clients.firmId })
        .from(clients)
        .where(eq(clients.id, eng.clientId))
        .limit(1);
      if (!client || client.firmId !== session.firmId) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }

      const batchId = await deps.db.transaction(async (tx) => {
        const [batch] = await tx
          .insert(billingBatches)
          .values({
            engagementId: eng.id,
            periodStart: parsed.data.periodStart,
            periodEnd: parsed.data.periodEnd,
            createdById: session.appUserId,
          })
          .returning({ id: billingBatches.id });
        if (!batch) throw new Error('batch insert failed');

        // Pull unbilled time entries in the period.
        const rows = await tx
          .select({ id: timeEntries.id })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.engagementId, eng.id),
              isNull(timeEntries.billingBatchId),
              between(timeEntries.entryDate, parsed.data.periodStart, parsed.data.periodEnd),
            ),
          );

        if (rows.length > 0) {
          await tx.insert(billingBatchEntries).values(
            rows.map((r) => ({
              billingBatchId: batch.id,
              timeEntryId: r.id,
              action: 'INCLUDE' as const,
            })),
          );
          // Assign the batch to each entry (denormalized for fast filtering).
          for (const r of rows) {
            await tx
              .update(timeEntries)
              .set({ billingBatchId: batch.id })
              .where(eq(timeEntries.id, r.id));
          }
        }
        return batch.id;
      });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'billing_batch',
        entityId: batchId,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.status(201).json({ id: batchId });
    },
  );

  router.get(
    '/',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const firmClients = await deps.db
        .select({ id: clients.id, name: clients.name })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      if (firmClients.length === 0) {
        res.json({ items: [] });
        return;
      }
      const clientMap = new Map(firmClients.map((c) => [c.id, c.name]));
      const firmEngagements = await deps.db
        .select({ id: engagements.id, name: engagements.name, clientId: engagements.clientId })
        .from(engagements);
      const engMap = new Map(
        firmEngagements.filter((e) => clientMap.has(e.clientId)).map((e) => [e.id, e]),
      );
      if (engMap.size === 0) {
        res.json({ items: [] });
        return;
      }
      const allBatches = await deps.db.select().from(billingBatches).limit(500);
      const items = allBatches
        .filter((b) => engMap.has(b.engagementId))
        .map((b) => {
          const eng = engMap.get(b.engagementId)!;
          return {
            ...b,
            engagementName: eng.name,
            clientName: clientMap.get(eng.clientId) ?? null,
          };
        });
      res.json({ items });
    },
  );

  router.get(
    '/:id',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ batch: null, entries: [] });
        return;
      }
      const [batch] = await deps.db
        .select()
        .from(billingBatches)
        .where(eq(billingBatches.id, req.params['id']!))
        .limit(1);
      if (!batch) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const entries = await deps.db
        .select({
          timeEntryId: timeEntries.id,
          entryDate: timeEntries.entryDate,
          hours: timeEntries.hours,
          standardAmountCents: timeEntries.standardAmountCents,
          action: billingBatchEntries.action,
        })
        .from(billingBatchEntries)
        .innerJoin(timeEntries, eq(timeEntries.id, billingBatchEntries.timeEntryId))
        .where(eq(billingBatchEntries.billingBatchId, batch.id));

      const aging = bucketize(
        entries.map((e) => ({ entryDate: e.entryDate, amountCents: e.standardAmountCents })),
        new Date().toISOString().slice(0, 10),
      );

      res.json({ batch, entries, aging });
    },
  );

  router.patch(
    '/:id/finalize',
    requirePermission(deps, 'billing_batch:approve'),
    async (req: Request, res: Response) => {
      const parsed = FinalizeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }

      await deps.db.transaction(async (tx) => {
        for (const a of parsed.data.actions) {
          await tx
            .update(billingBatchEntries)
            .set({ action: a.action, comment: a.comment ?? null })
            .where(
              and(
                eq(billingBatchEntries.billingBatchId, req.params['id']!),
                eq(billingBatchEntries.timeEntryId, a.timeEntryId),
              ),
            );
          // Phase 11 #23 — DEFER releases the entry so a future batch
          // can include it. Phase 11 #6 — WRITE_OFF_HELD keeps the entry
          // visible on WIP without immediate write-off; partner can
          // revisit later. Drop the billing_batch_id assignment for both.
          if (a.action === 'DEFER' || a.action === 'WRITE_OFF_HELD') {
            await tx
              .update(timeEntries)
              .set({ billingBatchId: null })
              .where(eq(timeEntries.id, a.timeEntryId));
          }
        }
        await tx
          .update(billingBatches)
          .set({
            status: 'APPROVED',
            approvedById: session.appUserId,
            finalizedAt: new Date(),
          })
          .where(eq(billingBatches.id, req.params['id']!));
      });

      const summary = parsed.data.actions.reduce(
        (s, a) => {
          // applyEntryAction returns the per-entry split; here we just count.
          const split = applyEntryAction({
            action: a.action as EntryAction,
            entryAmountCents: 0,
          });
          void split;
          s[a.action] = (s[a.action] ?? 0) + 1;
          return s;
        },
        {} as Record<string, number>,
      );

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'billing_batch',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: 'APPROVED', actions: summary },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.json({ ok: true, summary });
    },
  );

  // -----------------------------------------------------------------
  // Period-close bulk pre-bill (Phase 11 #11). Creates one billing
  // batch per engagement that has unbilled, submitted time entries in
  // the period. Returns the list of created batch IDs.
  // -----------------------------------------------------------------
  router.post(
    '/period-close',
    requirePermission(deps, 'billing_batch:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true, batches: [] });
        return;
      }
      const body = req.body as {
        periodStart?: unknown;
        periodEnd?: unknown;
        engagementIds?: unknown;
      };
      const start = typeof body.periodStart === 'string' ? body.periodStart : null;
      const end = typeof body.periodEnd === 'string' ? body.periodEnd : null;
      const re = /^\d{4}-\d{2}-\d{2}$/;
      if (!start || !end || !re.test(start) || !re.test(end)) {
        res.status(400).json({ error: 'period_start_end_required' });
        return;
      }
      const filter = Array.isArray(body.engagementIds)
        ? body.engagementIds.filter((x): x is string => typeof x === 'string')
        : null;
      // Find all engagements (within the firm) that have unbilled
      // entries in the window. Cap at 500 batches per call.
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      const cIds = firmClients.map((c) => c.id);
      if (cIds.length === 0) {
        res.json({ ok: true, batches: [], skipped: 0 });
        return;
      }
      const engs = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(
          and(
            inArray(engagements.clientId, cIds),
            eq(engagements.status, 'ACTIVE'),
            ...(filter ? [inArray(engagements.id, filter)] : []),
          ),
        );
      const engIds = engs.map((e) => e.id);
      if (engIds.length === 0) {
        res.json({ ok: true, batches: [], skipped: 0 });
        return;
      }
      // Engagements that actually have unbilled entries.
      const candidates = await deps.db
        .select({
          engagementId: timeEntries.engagementId,
          count: sql<number>`COUNT(*)`,
        })
        .from(timeEntries)
        .where(
          and(
            inArray(timeEntries.engagementId, engIds),
            isNull(timeEntries.billingBatchId),
            between(timeEntries.entryDate, start, end),
          ),
        )
        .groupBy(timeEntries.engagementId)
        .limit(500);
      const created: { engagementId: string; batchId: string; entries: number }[] = [];
      for (const c of candidates) {
        const batchId = await deps.db.transaction(async (tx) => {
          const [batch] = await tx
            .insert(billingBatches)
            .values({
              engagementId: c.engagementId,
              periodStart: start,
              periodEnd: end,
              createdById: session.appUserId,
            })
            .returning({ id: billingBatches.id });
          if (!batch) return null;
          const rows = await tx
            .select({ id: timeEntries.id })
            .from(timeEntries)
            .where(
              and(
                eq(timeEntries.engagementId, c.engagementId),
                isNull(timeEntries.billingBatchId),
                between(timeEntries.entryDate, start, end),
              ),
            );
          if (rows.length > 0) {
            await tx.insert(billingBatchEntries).values(
              rows.map((r) => ({
                billingBatchId: batch.id,
                timeEntryId: r.id,
                action: 'INCLUDE' as const,
              })),
            );
            for (const r of rows) {
              await tx
                .update(timeEntries)
                .set({ billingBatchId: batch.id })
                .where(eq(timeEntries.id, r.id));
            }
          }
          return batch.id;
        });
        if (batchId) {
          created.push({
            engagementId: c.engagementId,
            batchId,
            entries: Number(c.count),
          });
        }
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'billing_batch_bulk',
        actorAppUserId: session.appUserId,
        after: {
          kind: 'period_close',
          periodStart: start,
          periodEnd: end,
          created: created.length,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ ok: true, created, skipped: candidates.length - created.length });
    },
  );

  // -----------------------------------------------------------------
  // Firm-wide WIP dashboard (Phase 11 #25). Returns per-engagement
  // unbilled-time totals ordered by largest first.
  // -----------------------------------------------------------------
  router.get(
    '/wip-dashboard',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const rows = await deps.db
        .select({
          engagementId: engagements.id,
          engagementName: engagements.name,
          clientId: clients.id,
          clientName: clients.name,
          hours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
          entryCount: sql<number>`COUNT(${timeEntries.id})`,
          oldestDate: sql<string>`MIN(${timeEntries.entryDate})`,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .leftJoin(
          timeEntries,
          and(eq(timeEntries.engagementId, engagements.id), isNull(timeEntries.billingBatchId)),
        )
        .where(and(eq(clients.firmId, session.firmId), eq(engagements.status, 'ACTIVE')))
        .groupBy(engagements.id, engagements.name, clients.id, clients.name);
      res.json({
        asOf: new Date().toISOString().slice(0, 10),
        items: rows
          .map((r) => ({
            engagementId: r.engagementId,
            engagementName: r.engagementName,
            clientId: r.clientId,
            clientName: r.clientName,
            hours: Number(r.hours),
            amountCents: Number(r.amountCents),
            entryCount: Number(r.entryCount),
            oldestDate: r.oldestDate,
          }))
          .filter((r) => r.entryCount > 0)
          .sort((a, b) => b.amountCents - a.amountCents),
      });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
