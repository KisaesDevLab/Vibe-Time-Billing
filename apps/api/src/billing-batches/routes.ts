// SPDX-License-Identifier: Elastic-2.0
//
// Billing batch (pre-bill) endpoints — Phase 11. Creates a batch over
// the engagement's unbilled time entries in a period, links each entry
// via billing_batch_entry, and assigns the batch to those entries.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, between, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  adjustmentAllocations,
  adjustments,
  appUsers,
  billingBatchEngagements,
  billingBatchEntries,
  billingBatchExpenses,
  billingBatches,
  clients,
  engagementExpenses,
  engagements,
  firmRetainerSettings,
  firmSettings,
  invoiceLineItems,
  invoices,
  timeEntries,
  workCodes,
} from '@vibe/db/schema';
import { applyEntryAction, bucketize, type EntryAction } from '@vibe/core/billing';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';
import { renderHtmlToPdf } from '../pdf/render';

export interface BillingBatchRoutesDeps extends RbacDeps {
  db: Database | null;
  // Phase 11 #9 — wired for emailable pre-bill.
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
}

// 0086 — accepts either the legacy single `engagementId` or the new
// `engagementIds: [...]` array. The single shape is preserved so
// external callers (mcp server, scripts) keep working unchanged; the
// staff UI moves to the array shape so one batch can span N
// engagements for the same client and produce a consolidated invoice.
const CreateSchema = z
  .object({
    engagementId: z.string().uuid().optional(),
    engagementIds: z.array(z.string().uuid()).min(1).max(50).optional(),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // 0050 — kind defaults to STANDARD. A RETAINER batch must declare a
    // positive target (DB check constraint enforces the invariant).
    // RETAINER batches stay single-engagement (see "out of scope").
    kind: z.enum(['STANDARD', 'RETAINER']).optional(),
    retainerTargetAmountCents: z.number().int().positive().optional(),
  })
  .refine((v) => v.engagementId != null || (v.engagementIds && v.engagementIds.length > 0), {
    message: 'engagementId or engagementIds is required',
  });

const EntryActionSchema = z.object({
  timeEntryId: z.string().uuid(),
  action: z.enum(['INCLUDE', 'DEFER', 'WRITE_OFF', 'WRITE_OFF_HELD']),
  comment: z.string().max(500).optional(),
});

// 0199 — expense actions applied at finalize (parallels EntryActionSchema
// but keyed on the expense + carries the resolved billed amount).
const ExpenseActionSchema = z.object({
  expenseId: z.string().uuid(),
  action: z.enum(['INCLUDE', 'DEFER', 'WRITE_OFF', 'WRITE_OFF_HELD']),
  billedAmountCents: z.number().int().nonnegative().optional(),
  comment: z.string().max(500).optional(),
});

const FinalizeSchema = z.object({
  actions: z.array(EntryActionSchema).min(1).max(5000),
  // 0199 — optional expense action set. Absent = expenses keep their
  // current action/billed amount.
  expenseActions: z.array(ExpenseActionSchema).max(5000).optional(),
});

// 0199 — default markup applied to a claimed expense's cost when it is
// first pulled into a batch (cost + 15%). Editable on the billing screen.
const DEFAULT_EXPENSE_MARKUP_PCT = 15;

function billedFromCost(costCents: number, markupPct: number): number {
  return Math.round(costCents * (1 + markupPct / 100));
}

export function createBillingBatchRouter(deps: BillingBatchRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

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

      // 0086 — normalize to an engagement-id list. Preserves pick order
      // so the first id becomes the batch's "primary" engagement (the
      // legacy engagement_id pointer); all of them get a row in the
      // billing_batch_engagement join.
      const engIds =
        parsed.data.engagementIds && parsed.data.engagementIds.length > 0
          ? parsed.data.engagementIds
          : [parsed.data.engagementId!];
      // Dedupe in pick order.
      const seen = new Set<string>();
      const uniqEngIds = engIds.filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const engRows = await deps.db
        .select({
          id: engagements.id,
          clientId: engagements.clientId,
          nteCapCents: engagements.nteCapCents,
        })
        .from(engagements)
        .where(inArray(engagements.id, uniqEngIds));
      if (engRows.length !== uniqEngIds.length) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      // All engagements must belong to the same client.
      const clientIds = new Set(engRows.map((e) => e.clientId));
      if (clientIds.size > 1) {
        res.status(400).json({ error: 'mixed_clients' });
        return;
      }
      const [clientId] = Array.from(clientIds);
      const [client] = await deps.db
        .select({ firmId: clients.firmId })
        .from(clients)
        .where(eq(clients.id, clientId!))
        .limit(1);
      if (!client || client.firmId !== session.firmId) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }

      // 0050 — retainer validation. Kind defaults to STANDARD.
      // 0086 — RETAINER batches must remain single-engagement (the
      // activation flow ties to one engagement's tier config).
      const kind = parsed.data.kind ?? 'STANDARD';
      if (kind === 'RETAINER' && uniqEngIds.length > 1) {
        res.status(400).json({ error: 'retainer_batch_single_engagement_only' });
        return;
      }
      if (kind === 'RETAINER' && !parsed.data.retainerTargetAmountCents) {
        res.status(400).json({ error: 'retainer_target_required' });
        return;
      }
      if (kind === 'STANDARD' && parsed.data.retainerTargetAmountCents != null) {
        res.status(400).json({ error: 'standard_batch_no_target' });
        return;
      }

      // NTE cap check (Phase 11 #18): each engagement with a per-period
      // NTE has its own cap evaluated independently against its slice
      // of unbilled WIP. If any single engagement would exceed its cap
      // the batch is rejected outright.
      for (const eng of engRows) {
        if (eng.nteCapCents != null && Number(eng.nteCapCents) > 0) {
          const [projected] = await deps.db
            .select({
              total: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
            })
            .from(timeEntries)
            .where(
              and(
                eq(timeEntries.engagementId, eng.id),
                isNull(timeEntries.billingBatchId),
                between(timeEntries.entryDate, parsed.data.periodStart, parsed.data.periodEnd),
              ),
            );
          const projectedCents = Number(projected?.total ?? 0);
          if (projectedCents > Number(eng.nteCapCents)) {
            res.status(409).json({
              error: 'nte_cap_exceeded',
              engagementId: eng.id,
              capCents: Number(eng.nteCapCents),
              projectedCents,
            });
            return;
          }
        }
      }

      const batchId = await deps.db.transaction(async (tx) => {
        const [batch] = await tx
          .insert(billingBatches)
          .values({
            engagementId: uniqEngIds[0]!, // primary pointer; backward-compat for legacy readers
            periodStart: parsed.data.periodStart,
            periodEnd: parsed.data.periodEnd,
            createdById: session.appUserId,
            kind,
            retainerTargetAmountCents:
              kind === 'RETAINER' ? parsed.data.retainerTargetAmountCents! : null,
          })
          .returning({ id: billingBatches.id });
        if (!batch) throw new Error('batch insert failed');

        // 0086 — record the full engagement set in the join table.
        // Pick order is preserved via `ordinal` so UI can render the
        // primary first.
        await tx.insert(billingBatchEngagements).values(
          uniqEngIds.map((id, idx) => ({
            billingBatchId: batch.id,
            engagementId: id,
            ordinal: idx,
          })),
        );

        // Pull unbilled time entries in the period across all selected
        // engagements. 0086 — IN-list replaces the single eq().
        const rows = await tx
          .select({ id: timeEntries.id })
          .from(timeEntries)
          .where(
            and(
              inArray(timeEntries.engagementId, uniqEngIds),
              isNull(timeEntries.billingBatchId),
              between(timeEntries.entryDate, parsed.data.periodStart, parsed.data.periodEnd),
              sql`${timeEntries.status} <> 'ARCHIVED'`,
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

        // 0199 — pull unbilled engagement expenses in the period the same
        // way. Each is billed at cost + default markup; INCLUDE by default.
        const expenseRows = await tx
          .select({ id: engagementExpenses.id, costCents: engagementExpenses.costCents })
          .from(engagementExpenses)
          .where(
            and(
              inArray(engagementExpenses.engagementId, uniqEngIds),
              isNull(engagementExpenses.billingBatchId),
              eq(engagementExpenses.status, 'ACTIVE'),
              between(
                engagementExpenses.expenseDate,
                parsed.data.periodStart,
                parsed.data.periodEnd,
              ),
            ),
          );
        if (expenseRows.length > 0) {
          await tx.insert(billingBatchExpenses).values(
            expenseRows.map((e) => ({
              billingBatchId: batch.id,
              expenseId: e.id,
              action: 'INCLUDE' as const,
              billedAmountCents: billedFromCost(Number(e.costCents), DEFAULT_EXPENSE_MARKUP_PCT),
            })),
          );
          for (const e of expenseRows) {
            await tx
              .update(engagementExpenses)
              .set({ billingBatchId: batch.id, updatedAt: new Date() })
              .where(eq(engagementExpenses.id, e.id));
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
      // 0182 — realization-only close-out batches are not pre-bills; keep them
      // out of the invoiceable queue so they can't be invoiced from the UI.
      const allBatches = await deps.db
        .select()
        .from(billingBatches)
        .where(eq(billingBatches.realizationOnly, false))
        .limit(500);
      const batchIds = allBatches.map((b) => b.id);
      // 0086 — pull every batch's engagement list in one query so we can
      // render multi-engagement batches without N+1.
      const engLinks = batchIds.length
        ? await deps.db
            .select()
            .from(billingBatchEngagements)
            .where(inArray(billingBatchEngagements.billingBatchId, batchIds))
        : [];
      const linksByBatch = new Map<string, string[]>();
      // Sort by ordinal so the primary engagement leads.
      for (const link of engLinks.sort((a, b) => a.ordinal - b.ordinal)) {
        const arr = linksByBatch.get(link.billingBatchId) ?? [];
        arr.push(link.engagementId);
        linksByBatch.set(link.billingBatchId, arr);
      }
      const items = allBatches
        .filter((b) => b.engagementId != null && engMap.has(b.engagementId))
        .map((b) => {
          const primary = engMap.get(b.engagementId!)!;
          const ids = linksByBatch.get(b.id) ?? [b.engagementId!];
          const engs = ids
            .map((id) => engMap.get(id))
            .filter((e): e is NonNullable<typeof e> => e != null)
            .map((e) => ({ id: e.id, name: e.name }));
          return {
            ...b,
            engagementName: primary.name,
            engagements: engs,
            clientName: clientMap.get(primary.clientId) ?? null,
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
          costRateSnapshotCents: timeEntries.costRateSnapshotCents,
          action: billingBatchEntries.action,
          appUserId: timeEntries.appUserId,
          // 0050 — surface timekeeper name + engagement client on each row
          // so the batch detail UI can render "Staff" and client columns
          // without a second roundtrip.
          staffName: appUsers.fullName,
          description: timeEntries.description,
          workCode: workCodes.name,
        })
        .from(billingBatchEntries)
        .innerJoin(timeEntries, eq(timeEntries.id, billingBatchEntries.timeEntryId))
        .leftJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
        .leftJoin(workCodes, eq(workCodes.id, timeEntries.workCodeId))
        .where(eq(billingBatchEntries.billingBatchId, batch.id));

      // 0086 — load every engagement on the batch (primary + extras)
      // in ordinal order. Single-engagement batches still produce a
      // one-element array, so the UI can render uniformly.
      const links = await deps.db
        .select({ engagementId: billingBatchEngagements.engagementId })
        .from(billingBatchEngagements)
        .where(eq(billingBatchEngagements.billingBatchId, batch.id))
        .orderBy(billingBatchEngagements.ordinal);
      const linkedIds = links.map((l) => l.engagementId);
      // Fallback for any batch that pre-dates the join backfill
      // (defensive; the migration covers all existing rows).
      const engIds =
        linkedIds.length > 0 ? linkedIds : batch.engagementId ? [batch.engagementId] : [];
      const engRows = engIds.length
        ? await deps.db
            .select({
              id: engagements.id,
              name: engagements.name,
              clientId: clients.id,
              clientName: clients.name,
            })
            .from(engagements)
            .innerJoin(clients, eq(clients.id, engagements.clientId))
            .where(inArray(engagements.id, engIds))
        : [];
      // Preserve ordinal order.
      const engRowById = new Map(engRows.map((r) => [r.id, r]));
      const engs = engIds
        .map((id) => engRowById.get(id))
        .filter((r): r is NonNullable<typeof r> => r != null);
      const eng = engs[0] ?? null;

      const aging = bucketize(
        entries.map((e) => ({ entryDate: e.entryDate, amountCents: e.standardAmountCents })),
        new Date().toISOString().slice(0, 10),
      );

      // R2 — surface the firm's retainer feature flag + the default biller
      // toggle so the biller's "Offer retainer to client" checkbox can
      // initialize from firm_retainer_settings without calling the
      // partner-only tier-config endpoint. Defaults mirror the schema
      // (feature off, toggle on) when no settings row exists yet.
      const session = req.staffSession!;
      const [retainerSettings] = await deps.db
        .select({
          featureEnabled: firmRetainerSettings.featureEnabled,
          defaultBillerToggleOn: firmRetainerSettings.defaultBillerToggleOn,
        })
        .from(firmRetainerSettings)
        .where(eq(firmRetainerSettings.firmId, session.firmId))
        .limit(1);
      const retainer = {
        featureEnabled: retainerSettings?.featureEnabled ?? false,
        defaultBillerToggleOn: retainerSettings?.defaultBillerToggleOn ?? true,
      };

      // 0052 — sum existing approved/applied adjustments on this batch
      // so the UI can show a true "Total to invoice" = INCLUDE sum +
      // signed adjustment total. Draft/Rejected/Reversed don't apply.
      const [adjSum] = await deps.db
        .select({
          total: sql<number>`COALESCE(SUM(${adjustments.totalAmountCents}), 0)`.as('total'),
        })
        .from(adjustments)
        .where(
          and(
            eq(adjustments.billingBatchId, batch.id),
            inArray(adjustments.status, ['APPROVED', 'APPLIED']),
          ),
        );
      const adjustmentTotalCents = Number(adjSum?.total ?? 0);

      // Per-entry allocated adjustment (sum of allocations across this
      // batch's APPROVED/APPLIED adjustments) → per-entry "billed". An
      // INCLUDE entry's billed = standard + its signed adjustment;
      // deferred / written-off entries aren't invoiced, so billed = 0.
      const allocRows = await deps.db
        .select({
          timeEntryId: adjustmentAllocations.timeEntryId,
          amount: sql<number>`COALESCE(SUM(${adjustmentAllocations.adjustmentAmountCents}), 0)`.as(
            'amount',
          ),
        })
        .from(adjustmentAllocations)
        .innerJoin(adjustments, eq(adjustments.id, adjustmentAllocations.adjustmentId))
        .where(
          and(
            eq(adjustments.billingBatchId, batch.id),
            inArray(adjustments.status, ['APPROVED', 'APPLIED']),
          ),
        )
        .groupBy(adjustmentAllocations.timeEntryId);
      const adjByEntry = new Map(allocRows.map((r) => [r.timeEntryId, Number(r.amount)]));
      // Some adjustments (e.g. the "set target" delta) are header-only with
      // no per-entry allocation rows. Distribute that UNALLOCATED remainder
      // pro-rata by standard value across the included entries so the billed
      // column always reconciles to Total-to-invoice (= included std + adj).
      const totalAllocated = allocRows.reduce((s, r) => s + Number(r.amount), 0);
      const unallocated = adjustmentTotalCents - totalAllocated;
      const includedEntries = entries.filter((e) => e.action === 'INCLUDE');
      const includedStdSum = includedEntries.reduce((s, e) => s + e.standardAmountCents, 0);
      const proRata = new Map<string, number>();
      if (unallocated !== 0 && includedStdSum > 0) {
        let running = 0;
        includedEntries.forEach((e, i) => {
          const share =
            i === includedEntries.length - 1
              ? unallocated - running // last entry absorbs the rounding remainder
              : Math.round((unallocated * e.standardAmountCents) / includedStdSum);
          running += share;
          proRata.set(e.timeEntryId, share);
        });
      }
      const entriesWithBilled = entries.map((e) => {
        const adj =
          e.action === 'INCLUDE'
            ? (adjByEntry.get(e.timeEntryId) ?? 0) + (proRata.get(e.timeEntryId) ?? 0)
            : 0;
        const billedAmountCents = e.action === 'INCLUDE' ? e.standardAmountCents + adj : 0;
        // Cost of labor for this entry (hours × snapshotted cost rate); drives
        // the minimum-estimate-fee card on the billing screen.
        const costOfLaborCents = Math.round(Number(e.hours) * (e.costRateSnapshotCents ?? 0));
        return { ...e, adjustmentAmountCents: adj, billedAmountCents, costOfLaborCents };
      });

      // 0199 — expenses on this batch (cost + markup billed items). No
      // timekeeper, so they never touch the per-entry allocation math above;
      // billed = stored billed_amount_cents when INCLUDE, else 0.
      const expenseRows = await deps.db
        .select({
          expenseId: engagementExpenses.id,
          expenseDate: engagementExpenses.expenseDate,
          description: engagementExpenses.description,
          costCents: engagementExpenses.costCents,
          category: engagementExpenses.category,
          vendor: engagementExpenses.vendor,
          engagementId: engagementExpenses.engagementId,
          action: billingBatchExpenses.action,
          billedAmountCents: billingBatchExpenses.billedAmountCents,
        })
        .from(billingBatchExpenses)
        .innerJoin(engagementExpenses, eq(engagementExpenses.id, billingBatchExpenses.expenseId))
        .where(eq(billingBatchExpenses.billingBatchId, batch.id));
      const expenses = expenseRows.map((e) => ({
        ...e,
        costCents: Number(e.costCents),
        billedAmountCents: e.action === 'INCLUDE' ? Number(e.billedAmountCents ?? 0) : 0,
      }));

      // When the batch is invoiced, surface the invoice id so the UI can
      // print / send / unfinalize. The link lives on the invoice's line
      // items (sourceRefType='billing_batch', sourceRefId=batch.id).
      let invoiceId: string | null = null;
      if (batch.status === 'INVOICED') {
        const [li] = await deps.db
          .select({ invoiceId: invoiceLineItems.invoiceId })
          .from(invoiceLineItems)
          .where(
            and(
              eq(invoiceLineItems.sourceRefType, 'billing_batch'),
              eq(invoiceLineItems.sourceRefId, batch.id),
            ),
          )
          .limit(1);
        invoiceId = li?.invoiceId ?? null;
      }

      // 0202 — firm's estimated labor % drives the minimum-estimate-fee card.
      const [laborCfg] = await deps.db
        .select({ pct: firmSettings.estimatedLaborPct })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, session.firmId))
        .limit(1);

      res.json({
        batch,
        entries: entriesWithBilled,
        expenses,
        aging,
        engagement: eng,
        engagements: engs,
        adjustmentTotalCents,
        invoiceId,
        retainer,
        estimatedLaborPct: laborCfg?.pct ?? 40,
      });
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
        // 0199 — mirror the same lifecycle for expenses. Persist action +
        // (optional) billed amount; DEFER / WRITE_OFF_HELD release the
        // expense back to the pool for a future batch. WRITE_OFF stays in
        // this batch billed 0.
        for (const x of parsed.data.expenseActions ?? []) {
          await tx
            .update(billingBatchExpenses)
            .set({
              action: x.action,
              comment: x.comment ?? null,
              ...(x.billedAmountCents !== undefined
                ? { billedAmountCents: x.billedAmountCents }
                : {}),
            })
            .where(
              and(
                eq(billingBatchExpenses.billingBatchId, req.params['id']!),
                eq(billingBatchExpenses.expenseId, x.expenseId),
              ),
            );
          if (x.action === 'DEFER' || x.action === 'WRITE_OFF_HELD') {
            await tx
              .update(engagementExpenses)
              .set({ billingBatchId: null, updatedAt: new Date() })
              .where(eq(engagementExpenses.id, x.expenseId));
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
  // Draft-save per-entry / per-expense actions WITHOUT finalizing. The UI
  // calls this whenever a biller flips an INCLUDE/DEFER/WRITE_OFF picker so
  // that set-target and create-adjustment (both of which read
  // billing_batch_entry.action from the DB to build the allocation universe)
  // see the current selection. Unlike finalize this does NOT change batch
  // status and does NOT release billing_batch_id — the entry/expense stays
  // in the batch until finalize actually releases DEFER/held rows.
  // -----------------------------------------------------------------
  const SaveActionsSchema = z.object({
    actions: z.array(EntryActionSchema).max(5000).optional(),
    expenseActions: z.array(ExpenseActionSchema).max(5000).optional(),
  });
  router.patch(
    '/:id/actions',
    requirePermission(deps, 'billing_batch:write'),
    async (req: Request, res: Response) => {
      const parsed = SaveActionsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      // Draft action saves are transient (a biller may toggle a picker many
      // times); the final set is audited at finalize, so we don't emit here.
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [batch] = await deps.db
        .select({ id: billingBatches.id, status: billingBatches.status })
        .from(billingBatches)
        .where(eq(billingBatches.id, req.params['id']!))
        .limit(1);
      if (!batch) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Actions are only editable while the batch is still a draft.
      if (batch.status !== 'DRAFT' && batch.status !== 'IN_REVIEW') {
        res.status(409).json({ error: 'batch_not_editable' });
        return;
      }
      await deps.db.transaction(async (tx) => {
        for (const a of parsed.data.actions ?? []) {
          await tx
            .update(billingBatchEntries)
            .set({ action: a.action, comment: a.comment ?? null })
            .where(
              and(
                eq(billingBatchEntries.billingBatchId, batch.id),
                eq(billingBatchEntries.timeEntryId, a.timeEntryId),
              ),
            );
        }
        for (const x of parsed.data.expenseActions ?? []) {
          await tx
            .update(billingBatchExpenses)
            .set({
              action: x.action,
              comment: x.comment ?? null,
              ...(x.billedAmountCents !== undefined
                ? { billedAmountCents: x.billedAmountCents }
                : {}),
            })
            .where(
              and(
                eq(billingBatchExpenses.billingBatchId, batch.id),
                eq(billingBatchExpenses.expenseId, x.expenseId),
              ),
            );
        }
      });
      res.json({ ok: true });
    },
  );

  // -----------------------------------------------------------------
  // Emailable pre-bill (Phase 11 #9). Sends a plaintext pre-bill summary
  // to the configured partner-review email. The body lists the included
  // time entries grouped by user. No PDF — fast text only.
  // -----------------------------------------------------------------
  router.post(
    '/:id/email-prebill',
    requirePermission(deps, 'billing_batch:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, sent: false });
        return;
      }
      const body = req.body as { to?: unknown };
      const to = typeof body.to === 'string' ? body.to : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        res.status(400).json({ error: 'invalid_to' });
        return;
      }
      const [batch] = await deps.db
        .select()
        .from(billingBatches)
        .innerJoin(engagements, eq(engagements.id, billingBatches.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(billingBatches.id, req.params['id']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!batch) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const rows = await deps.db
        .select({
          entryDate: timeEntries.entryDate,
          hours: timeEntries.hours,
          amountCents: timeEntries.standardAmountCents,
          appUserId: timeEntries.appUserId,
          description: timeEntries.description,
        })
        .from(timeEntries)
        .where(eq(timeEntries.billingBatchId, batch.billing_batch.id));
      const total = rows.reduce((a, r) => a + Number(r.amountCents), 0);
      const totalHours = rows.reduce((a, r) => a + Number(r.hours), 0);
      const lines = [
        `Pre-bill: ${batch.client.name} · ${batch.engagement.name}`,
        `Period: ${batch.billing_batch.periodStart} → ${batch.billing_batch.periodEnd}`,
        `Entries: ${rows.length} · Hours: ${totalHours.toFixed(2)} · Total: $${(total / 100).toFixed(2)}`,
        '',
        '--- Entries ---',
        ...rows.map(
          (r) =>
            `${r.entryDate}  ${Number(r.hours).toFixed(2)}h  $${(Number(r.amountCents) / 100).toFixed(2)}  ${r.description ?? ''}`,
        ),
      ];
      const emailBody = lines.join('\n');
      let sent = false;
      let dispatchError: string | null = null;
      if (deps.sendEmail) {
        try {
          await deps.sendEmail({
            to,
            subject: `Pre-bill ready: ${batch.client.name} · ${batch.engagement.name} (${batch.billing_batch.periodStart} → ${batch.billing_batch.periodEnd})`,
            body: emailBody,
          });
          sent = true;
        } catch (err) {
          dispatchError = err instanceof Error ? err.message : 'dispatch_failed';
        }
      }
      await emitAudit(deps.db, {
        action: 'EXPORT',
        entityType: 'billing_batch',
        entityId: batch.billing_batch.id,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'email_prebill',
          to,
          entryCount: rows.length,
          totalCents: total,
          sent,
          dispatchError,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, sent, dispatchError, preview: emailBody });
    },
  );

  // Phase 11 #10 — assign-partner. PATCH the assignedPartnerId on a
  // pre-bill so a different partner reviews than the engagement's
  // partner-in-charge. NULL = inherit engagement partner.
  router.patch(
    '/:id/assign-partner',
    requirePermission(deps, 'billing_batch:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { partnerId?: unknown };
      const partnerId =
        body.partnerId === null ? null : typeof body.partnerId === 'string' ? body.partnerId : null;
      const [row] = await deps.db
        .select({ id: billingBatches.id, firmId: clients.firmId })
        .from(billingBatches)
        .innerJoin(engagements, eq(engagements.id, billingBatches.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(eq(billingBatches.id, req.params['id']!))
        .limit(1);
      if (!row || row.firmId !== session.firmId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(billingBatches)
        .set({ assignedPartnerId: partnerId })
        .where(eq(billingBatches.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'billing_batch',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { kind: 'assign_partner', partnerId },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, assignedPartnerId: partnerId });
    },
  );

  // Phase 11 #8 — pre-bill PDF. Renders an HTML view of the batch
  // (totals + entries + write-off summary) and pipes through Puppeteer.
  // ?mode=html returns the HTML preview directly (no Chrome needed in
  // dev).
  router.get(
    '/:id/pdf',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [batch] = await deps.db
        .select()
        .from(billingBatches)
        .innerJoin(engagements, eq(engagements.id, billingBatches.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(billingBatches.id, req.params['id']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!batch) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const entryRows = await deps.db
        .select({
          entryDate: timeEntries.entryDate,
          hours: timeEntries.hours,
          amountCents: timeEntries.standardAmountCents,
          appUserId: timeEntries.appUserId,
          appUserName: appUsers.fullName,
          description: timeEntries.description,
        })
        .from(timeEntries)
        .leftJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
        .where(eq(timeEntries.billingBatchId, batch.billing_batch.id))
        .orderBy(timeEntries.entryDate);
      const total = entryRows.reduce((a, r) => a + Number(r.amountCents), 0);
      const totalHours = entryRows.reduce((a, r) => a + Number(r.hours), 0);

      const html = `<!doctype html><html><head><meta charset="utf-8"/>
<title>Pre-bill ${batch.engagement.name}</title>
<style>
  body { font: 13px -apple-system, BlinkMacSystemFont, sans-serif; color: #111; margin: 32px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #555; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #ddd; font-size: 12px; }
  th { text-align: left; background: #f4f6f9; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { border-top: 2px solid #333; border-bottom: none; font-weight: 600; }
</style>
</head><body>
  <h1>Pre-bill — ${escape(batch.client.name)}</h1>
  <div class="meta">
    <div><strong>${escape(batch.engagement.name)}</strong></div>
    <div>Period ${batch.billing_batch.periodStart} → ${batch.billing_batch.periodEnd}</div>
    <div>Status: ${batch.billing_batch.status} · ${entryRows.length} entries</div>
  </div>
  <table>
    <thead>
      <tr><th>Date</th><th>Timekeeper</th><th class="num">Hours</th><th class="num">Amount</th><th>Description</th></tr>
    </thead>
    <tbody>
      ${entryRows
        .map(
          (r) => `<tr>
        <td>${r.entryDate}</td>
        <td>${escape(r.appUserName ?? r.appUserId.slice(0, 8))}</td>
        <td class="num">${Number(r.hours).toFixed(2)}</td>
        <td class="num">$${(Number(r.amountCents) / 100).toFixed(2)}</td>
        <td>${escape(r.description ?? '')}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
    <tfoot>
      <tr><td colspan="2">Totals</td><td class="num">${totalHours.toFixed(2)}</td><td class="num">$${(total / 100).toFixed(2)}</td><td></td></tr>
    </tfoot>
  </table>
</body></html>`;

      const wantHtml =
        req.query['mode'] === 'html' || req.headers.accept?.toString().includes('text/html');
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
        return;
      }
      try {
        const pdf = await renderHtmlToPdf(html);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `inline; filename="prebill-${batch.engagement.name.replace(/[^a-z0-9]+/gi, '-')}.pdf"`,
        );
        res.send(pdf);
      } catch (err) {
        logger.warn({ err }, 'puppeteer not available — falling back to HTML');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      }
    },
  );

  // -----------------------------------------------------------------
  // Subscription overage split (Phase 11 #19). For a RECURRING_SUBSCRIPTION
  // engagement, splits the batch's standard amount into in-scope vs overage.
  // -----------------------------------------------------------------
  router.get(
    '/:id/subscription-split',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ summary: null });
        return;
      }
      const [batch] = await deps.db
        .select()
        .from(billingBatches)
        .innerJoin(engagements, eq(engagements.id, billingBatches.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(billingBatches.id, req.params['id']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!batch) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const eng = batch.engagement;
      if (eng.feeStructure !== 'RECURRING_SUBSCRIPTION') {
        res
          .status(409)
          .json({ error: 'not_subscription_engagement', feeStructure: eng.feeStructure });
        return;
      }
      const [inScope] = await deps.db
        .select({
          hours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.billingBatchId, batch.billing_batch.id),
            eq(timeEntries.inScopeFlag, true),
          ),
        );
      const [outOfScope] = await deps.db
        .select({
          hours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.billingBatchId, batch.billing_batch.id),
            eq(timeEntries.inScopeFlag, false),
          ),
        );
      res.json({
        summary: {
          batchId: batch.billing_batch.id,
          subscriptionFeeCents: eng.feeAmountCents != null ? Number(eng.feeAmountCents) : null,
          inScope: {
            hours: Number(inScope?.hours ?? 0),
            amountCents: Number(inScope?.amountCents ?? 0),
          },
          overage: {
            hours: Number(outOfScope?.hours ?? 0),
            amountCents: Number(outOfScope?.amountCents ?? 0),
          },
        },
      });
    },
  );

  // -----------------------------------------------------------------
  // Reopen a finalized batch into a new version (Phase 11 #23).
  // Creates a fresh DRAFT batch with previousVersionId = current,
  // version = current.version + 1. Old batch flips to CANCELLED.
  // INCLUDED entries are released (billing_batch_id = null) so the
  // new batch can re-pull them; INVOICED status is preserved as a
  // metadata trail. The old invoice (if any) is left untouched.
  // -----------------------------------------------------------------
  router.post(
    '/:id/reopen',
    requirePermission(deps, 'billing_batch:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [batch] = await deps.db
        .select()
        .from(billingBatches)
        .innerJoin(engagements, eq(engagements.id, billingBatches.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(billingBatches.id, req.params['id']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!batch) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Refuse if already replaced by a newer version (avoid loops).
      const [child] = await deps.db
        .select({ id: billingBatches.id })
        .from(billingBatches)
        .where(eq(billingBatches.previousVersionId, batch.billing_batch.id))
        .limit(1);
      if (child) {
        res.status(409).json({ error: 'already_reopened', newVersionId: child.id });
        return;
      }
      const newId = await deps.db.transaction(async (tx) => {
        const [newBatch] = await tx
          .insert(billingBatches)
          .values({
            engagementId: batch.billing_batch.engagementId,
            periodStart: batch.billing_batch.periodStart,
            periodEnd: batch.billing_batch.periodEnd,
            status: 'DRAFT',
            createdById: session.appUserId,
            assignedPartnerId: batch.billing_batch.assignedPartnerId,
            previousVersionId: batch.billing_batch.id,
            version: (batch.billing_batch.version ?? 1) + 1,
          })
          .returning({ id: billingBatches.id });
        if (!newBatch) throw new Error('reopen_failed');
        // Release entries from the old batch and pull them into the new one.
        const entries = await tx
          .select({ id: timeEntries.id })
          .from(timeEntries)
          .where(eq(timeEntries.billingBatchId, batch.billing_batch.id));
        if (entries.length > 0) {
          await tx
            .update(timeEntries)
            .set({ billingBatchId: newBatch.id, lockedAt: null })
            .where(
              inArray(
                timeEntries.id,
                entries.map((e) => e.id),
              ),
            );
          await tx.insert(billingBatchEntries).values(
            entries.map((e) => ({
              billingBatchId: newBatch.id,
              timeEntryId: e.id,
              action: 'INCLUDE' as const,
            })),
          );
        }
        await tx
          .update(billingBatches)
          .set({ status: 'CANCELLED' })
          .where(eq(billingBatches.id, batch.billing_batch.id));
        return newBatch.id;
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'billing_batch',
        entityId: batch.billing_batch.id,
        actorAppUserId: session.appUserId,
        before: { status: batch.billing_batch.status, version: batch.billing_batch.version ?? 1 },
        after: { kind: 'reopened', newVersionId: newId },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, newVersionId: newId });
    },
  );

  // -----------------------------------------------------------------
  // Unfinalize an INVOICED batch: void the generated invoice AND reopen
  // the batch into a fresh editable DRAFT (one transaction). Refuses if
  // the invoice has any payment recorded. The new draft re-pulls the
  // entries so staff can re-adjust and re-finalize.
  // -----------------------------------------------------------------
  router.post(
    '/:id/unfinalize',
    requirePermission(deps, 'invoice:void'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [batch] = await deps.db
        .select()
        .from(billingBatches)
        .innerJoin(engagements, eq(engagements.id, billingBatches.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(billingBatches.id, req.params['id']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!batch) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (batch.billing_batch.status !== 'INVOICED') {
        res.status(409).json({ error: 'not_invoiced' });
        return;
      }
      // Find the generated invoice via its line items.
      const [li] = await deps.db
        .select({ invoiceId: invoiceLineItems.invoiceId })
        .from(invoiceLineItems)
        .where(
          and(
            eq(invoiceLineItems.sourceRefType, 'billing_batch'),
            eq(invoiceLineItems.sourceRefId, batch.billing_batch.id),
          ),
        )
        .limit(1);
      const [inv] = li
        ? await deps.db
            .select({ id: invoices.id, status: invoices.status, paidCents: invoices.paidCents })
            .from(invoices)
            .where(eq(invoices.id, li.invoiceId))
            .limit(1)
        : [];
      if (inv && Number(inv.paidCents) > 0) {
        res.status(409).json({ error: 'invoice_has_payments' });
        return;
      }

      const newId = await deps.db.transaction(async (tx) => {
        // Void the invoice (if still live).
        if (inv && inv.status !== 'VOIDED') {
          await tx
            .update(invoices)
            .set({ status: 'VOIDED', voidedAt: new Date(), voidedReason: 'unfinalized' })
            .where(eq(invoices.id, inv.id));
        }
        // Reopen the batch into a new DRAFT (mirror /reopen).
        const [newBatch] = await tx
          .insert(billingBatches)
          .values({
            engagementId: batch.billing_batch.engagementId,
            periodStart: batch.billing_batch.periodStart,
            periodEnd: batch.billing_batch.periodEnd,
            status: 'DRAFT',
            createdById: session.appUserId,
            assignedPartnerId: batch.billing_batch.assignedPartnerId,
            previousVersionId: batch.billing_batch.id,
            version: (batch.billing_batch.version ?? 1) + 1,
          })
          .returning({ id: billingBatches.id });
        if (!newBatch) throw new Error('unfinalize_failed');
        const entries = await tx
          .select({ id: timeEntries.id })
          .from(timeEntries)
          .where(eq(timeEntries.billingBatchId, batch.billing_batch.id));
        if (entries.length > 0) {
          await tx
            .update(timeEntries)
            .set({ billingBatchId: newBatch.id, lockedAt: null })
            .where(
              inArray(
                timeEntries.id,
                entries.map((e) => e.id),
              ),
            );
          await tx.insert(billingBatchEntries).values(
            entries.map((e) => ({
              billingBatchId: newBatch.id,
              timeEntryId: e.id,
              action: 'INCLUDE' as const,
            })),
          );
        }
        await tx
          .update(billingBatches)
          .set({ status: 'CANCELLED' })
          .where(eq(billingBatches.id, batch.billing_batch.id));
        return newBatch.id;
      });

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'billing_batch',
        entityId: batch.billing_batch.id,
        actorAppUserId: session.appUserId,
        before: { status: 'INVOICED' },
        after: { kind: 'unfinalized', newVersionId: newId, voidedInvoiceId: inv?.id ?? null },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, newVersionId: newId, voidedInvoiceId: inv?.id ?? null });
    },
  );

  // -----------------------------------------------------------------
  // Recompute a batch (Phase 11 #21). Re-aggregates time-entry totals
  // for the batch. Useful after a time entry was edited but the batch
  // was already created. Read-only — returns the recomputed numbers,
  // doesn't persist them (the next pre-bill regeneration will).
  // -----------------------------------------------------------------
  router.get(
    '/:id/recompute',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ summary: null });
        return;
      }
      const [batch] = await deps.db
        .select()
        .from(billingBatches)
        .innerJoin(engagements, eq(engagements.id, billingBatches.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(billingBatches.id, req.params['id']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!batch) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const rows = await deps.db
        .select({
          totalEntries: sql<number>`COUNT(*)`,
          totalHours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
          totalAmountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
          oldestDate: sql<string>`MIN(${timeEntries.entryDate})`,
        })
        .from(timeEntries)
        .where(eq(timeEntries.billingBatchId, batch.billing_batch.id));
      const r = rows[0]!;
      res.json({
        summary: {
          batchId: batch.billing_batch.id,
          totalEntries: Number(r.totalEntries),
          totalHours: Number(r.totalHours),
          totalAmountCents: Number(r.totalAmountCents),
          oldestDate: r.oldestDate,
          asOf: new Date().toISOString(),
        },
      });
    },
  );

  // -----------------------------------------------------------------
  // Budget compare for a batch (Phase 11 #20). Returns batch total vs
  // engagement budget (hours + cents), with utilization pct.
  // -----------------------------------------------------------------
  router.get(
    '/:id/budget-compare',
    requirePermission(deps, 'billing_batch:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ summary: null });
        return;
      }
      const [batch] = await deps.db
        .select()
        .from(billingBatches)
        .innerJoin(engagements, eq(engagements.id, billingBatches.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(billingBatches.id, req.params['id']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!batch) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [agg] = await deps.db
        .select({
          hours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
        })
        .from(timeEntries)
        .where(eq(timeEntries.billingBatchId, batch.billing_batch.id));
      const eng = batch.engagement;
      const batchHours = Number(agg?.hours ?? 0);
      const batchAmount = Number(agg?.amountCents ?? 0);
      const budgetHours = eng.budgetHours != null ? Number(eng.budgetHours) : null;
      const budgetAmount = eng.budgetAmountCents != null ? Number(eng.budgetAmountCents) : null;
      res.json({
        summary: {
          batchId: batch.billing_batch.id,
          batchHours,
          batchAmountCents: batchAmount,
          budgetHours,
          budgetAmountCents: budgetAmount,
          hoursUtilizationPct:
            budgetHours && budgetHours > 0 ? (batchHours / budgetHours) * 100 : null,
          amountUtilizationPct:
            budgetAmount && budgetAmount > 0 ? (batchAmount / budgetAmount) * 100 : null,
        },
      });
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
      // 0050 — accept clientId, engagementId, clientOwnerId filters.
      const conds = [eq(clients.firmId, session.firmId), eq(engagements.status, 'ACTIVE')];
      const clientId = uuidQueryParam(req.query['clientId']);
      const engagementId = uuidQueryParam(req.query['engagementId']);
      const clientOwnerId = uuidQueryParam(req.query['clientOwnerId']);
      if (clientId === 'invalid' || engagementId === 'invalid' || clientOwnerId === 'invalid') {
        res.status(400).json({ error: 'invalid_uuid_param' });
        return;
      }
      if (clientId) conds.push(eq(clients.id, clientId));
      if (engagementId) conds.push(eq(engagements.id, engagementId));
      if (clientOwnerId) conds.push(eq(clients.partnerInChargeId, clientOwnerId));

      const rows = await deps.db
        .select({
          engagementId: engagements.id,
          engagementName: engagements.name,
          clientId: clients.id,
          clientName: clients.name,
          clientOwnerId: clients.partnerInChargeId,
          hours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
          entryCount: sql<number>`COUNT(${timeEntries.id})`,
          oldestDate: sql<string>`MIN(${timeEntries.entryDate})`,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .leftJoin(
          timeEntries,
          and(
            eq(timeEntries.engagementId, engagements.id),
            isNull(timeEntries.billingBatchId),
            // 0050 — exclude soft-deleted entries.
            sql`${timeEntries.status} <> 'ARCHIVED'`,
          ),
        )
        .where(and(...conds))
        .groupBy(engagements.id, engagements.name, clients.id, clients.name);
      res.json({
        asOf: new Date().toISOString().slice(0, 10),
        items: rows
          .map((r) => ({
            engagementId: r.engagementId,
            engagementName: r.engagementName,
            clientId: r.clientId,
            clientName: r.clientName,
            clientOwnerId: r.clientOwnerId,
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

  // 0050 — bulk create billing batches (one per engagement) in a single
  // transaction. All-or-nothing: if any insert fails we roll back the
  // whole set so the caller sees a clean state.
  const BulkBatchSchema = z.object({
    engagements: z
      .array(
        z.object({
          engagementId: z.string().uuid(),
          periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      )
      .min(1)
      .max(200),
  });

  router.post(
    '/bulk',
    requirePermission(deps, 'billing_batch:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = BulkBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.status(201).json({ ok: true, created: 0, ids: [] });
        return;
      }
      // Scope check: each engagement must belong to a firm-owned client.
      const ids = parsed.data.engagements.map((e) => e.engagementId);
      const allowed = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(inArray(engagements.id, ids), eq(clients.firmId, session.firmId)));
      const allowedSet = new Set(allowed.map((r) => r.id));
      const filtered = parsed.data.engagements.filter((e) => allowedSet.has(e.engagementId));
      if (filtered.length === 0) {
        res.status(404).json({ error: 'no_valid_engagements' });
        return;
      }
      const created = await deps.db.transaction(async (tx) => {
        const rows = await tx
          .insert(billingBatches)
          .values(
            filtered.map((e) => ({
              engagementId: e.engagementId,
              periodStart: e.periodStart,
              periodEnd: e.periodEnd,
              createdById: session.appUserId,
            })),
          )
          .returning({ id: billingBatches.id, engagementId: billingBatches.engagementId });
        // 0086 — every batch needs a row in the join table, even when
        // the bulk path is 1-engagement-per-batch. Keeps GET handlers
        // uniform (they read engagements via the join, not the column).
        if (rows.length > 0) {
          await tx.insert(billingBatchEngagements).values(
            rows.map((r) => ({
              billingBatchId: r.id,
              engagementId: r.engagementId!,
              ordinal: 0,
            })),
          );
        }
        // 0050 — for each created batch, pull unbilled (non-archived)
        // time entries in the period and attach them. Mirrors the
        // single-batch POST so "Bill selected" produces batches with
        // their WIP, not empty shells.
        for (const batch of rows) {
          const req = filtered.find((e) => e.engagementId === batch.engagementId);
          if (!req) continue;
          const entries = await tx
            .select({ id: timeEntries.id })
            .from(timeEntries)
            .where(
              and(
                eq(timeEntries.engagementId, batch.engagementId),
                isNull(timeEntries.billingBatchId),
                between(timeEntries.entryDate, req.periodStart, req.periodEnd),
                sql`${timeEntries.status} <> 'ARCHIVED'`,
              ),
            );
          if (entries.length > 0) {
            await tx.insert(billingBatchEntries).values(
              entries.map((r) => ({
                billingBatchId: batch.id,
                timeEntryId: r.id,
                action: 'INCLUDE' as const,
              })),
            );
            for (const r of entries) {
              await tx
                .update(timeEntries)
                .set({ billingBatchId: batch.id })
                .where(eq(timeEntries.id, r.id));
            }
          }
        }
        return rows;
      });
      for (const row of created) {
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'billing_batch',
          entityId: row.id,
          actorAppUserId: session.appUserId,
          after: { engagementId: row.engagementId, source: 'bulk' },
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      }
      res.status(201).json({ ok: true, created: created.length, ids: created.map((r) => r.id) });
    },
  );

  // 0052 — auto-adjust to target. User declares an invoice total; the
  // server creates a single signed adjustment whose magnitude is the
  // delta between the current INCLUDE-sum and the target. Direction
  // (write-down vs write-up) is derived. Allocation defaults to
  // PRO_RATA_BY_VALUE. Reason code is required.
  const SetTargetSchema = z.object({
    targetAmountCents: z.number().int().nonnegative(),
    reasonCodeId: z.string().uuid(),
    notes: z.string().max(2000).optional(),
    allocationMethod: z
      .enum([
        'SPECIFIC_ENTRIES',
        'PRO_RATA_BY_VALUE',
        'PRO_RATA_BY_HOURS',
        'PARTNER_ABSORBS',
        'HIERARCHICAL_CASCADE',
        'CUSTOM_WEIGHTED',
      ])
      .optional(),
    // 0199 — markup applied to INCLUDE expenses (cost + markup%). The
    // resulting expense billed total is carved out of the target FIRST;
    // only the remainder is allocated across time. Default 15%.
    expenseMarkupPct: z.number().min(0).max(500).optional(),
  });

  router.post(
    '/:id/set-target',
    requirePermission(deps, 'billing_batch:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = SetTargetSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.json({ ok: true, deltaCents: 0 });
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
      // Compute current INCLUDE total + signed adjustment total.
      const [includeSum] = await deps.db
        .select({
          total: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as('total'),
        })
        .from(billingBatchEntries)
        .innerJoin(timeEntries, eq(timeEntries.id, billingBatchEntries.timeEntryId))
        .where(
          and(
            eq(billingBatchEntries.billingBatchId, batch.id),
            eq(billingBatchEntries.action, 'INCLUDE'),
          ),
        );
      const [adjSum] = await deps.db
        .select({
          total: sql<number>`COALESCE(SUM(${adjustments.totalAmountCents}), 0)`.as('total'),
        })
        .from(adjustments)
        .where(
          and(
            eq(adjustments.billingBatchId, batch.id),
            inArray(adjustments.status, ['APPROVED', 'APPLIED']),
          ),
        );
      const includeCents = Number(includeSum?.total ?? 0);
      const currentBilled = includeCents + Number(adjSum?.total ?? 0);

      // 0199 — expenses bill at cost + markup% and are carved out of the
      // target BEFORE the time write-up/down is computed. Recompute every
      // INCLUDE expense's billed amount from its cost + the supplied markup,
      // persist it, and subtract the total so the FEE adjustment (which
      // allocates across time only) targets just the remaining time portion.
      const markupPct = parsed.data.expenseMarkupPct ?? DEFAULT_EXPENSE_MARKUP_PCT;
      const includeExpenses = await deps.db
        .select({
          expenseId: billingBatchExpenses.expenseId,
          costCents: engagementExpenses.costCents,
        })
        .from(billingBatchExpenses)
        .innerJoin(engagementExpenses, eq(engagementExpenses.id, billingBatchExpenses.expenseId))
        .where(
          and(
            eq(billingBatchExpenses.billingBatchId, batch.id),
            eq(billingBatchExpenses.action, 'INCLUDE'),
          ),
        );
      let expenseBilledTotal = 0;
      for (const x of includeExpenses) {
        const billed = billedFromCost(Number(x.costCents), markupPct);
        expenseBilledTotal += billed;
        await deps.db
          .update(billingBatchExpenses)
          .set({ billedAmountCents: billed })
          .where(
            and(
              eq(billingBatchExpenses.billingBatchId, batch.id),
              eq(billingBatchExpenses.expenseId, x.expenseId),
            ),
          );
      }

      // The time target is what remains of the invoice target after
      // expenses. Signed delta — negative means write-down, positive write-up.
      const timeTarget = parsed.data.targetAmountCents - expenseBilledTotal;
      const deltaCents = timeTarget - currentBilled;
      if (deltaCents === 0) {
        res.json({ ok: true, deltaCents: 0, expenseBilledTotal, message: 'already at target' });
        return;
      }
      const [adj] = await deps.db
        .insert(adjustments)
        .values({
          billingBatchId: batch.id,
          method: 'FEE',
          allocationMethod: parsed.data.allocationMethod ?? 'PRO_RATA_BY_VALUE',
          totalAmountCents: deltaCents,
          reasonCodeId: parsed.data.reasonCodeId,
          notes: parsed.data.notes ?? null,
          status: 'APPROVED',
          createdById: session.appUserId,
          approverId: session.appUserId,
          approvedAt: new Date(),
        })
        .returning({ id: adjustments.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'adjustment',
        entityId: adj?.id,
        actorAppUserId: session.appUserId,
        after: {
          source: 'set_target',
          targetAmountCents: parsed.data.targetAmountCents,
          deltaCents,
          previousBilledCents: currentBilled,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({
        ok: true,
        adjustmentId: adj?.id,
        deltaCents,
        expenseBilledTotal,
        direction: deltaCents < 0 ? 'WRITE_DOWN' : 'WRITE_UP',
      });
    },
  );

  // 0052 — save invoice composition on the batch. UI editor allows the
  // CPA to set a custom invoice memo and split the bill into N line
  // items. We validate that line items sum to the current billed total
  // (INCLUDE + signed adjustments) so the invoice can't render with a
  // mismatch.
  const InvoiceCompositionSchema = z.object({
    invoiceDescription: z.string().max(4000).nullable().optional(),
    invoiceLineItems: z
      .array(
        z.object({
          description: z.string().min(1).max(500),
          amountCents: z.number().int(),
        }),
      )
      .max(50)
      .nullable()
      .optional(),
  });

  router.patch(
    '/:id/invoice-composition',
    requirePermission(deps, 'billing_batch:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = InvoiceCompositionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.json({ ok: true });
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
      // If line items are present, verify the sum matches billed total.
      if (parsed.data.invoiceLineItems && parsed.data.invoiceLineItems.length > 0) {
        const lineSum = parsed.data.invoiceLineItems.reduce((s, l) => s + l.amountCents, 0);
        const [includeSum] = await deps.db
          .select({
            total: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as('total'),
          })
          .from(billingBatchEntries)
          .innerJoin(timeEntries, eq(timeEntries.id, billingBatchEntries.timeEntryId))
          .where(
            and(
              eq(billingBatchEntries.billingBatchId, batch.id),
              eq(billingBatchEntries.action, 'INCLUDE'),
            ),
          );
        const [adjSum] = await deps.db
          .select({
            total: sql<number>`COALESCE(SUM(${adjustments.totalAmountCents}), 0)`.as('total'),
          })
          .from(adjustments)
          .where(
            and(
              eq(adjustments.billingBatchId, batch.id),
              inArray(adjustments.status, ['APPROVED', 'APPLIED']),
            ),
          );
        const billed = Number(includeSum?.total ?? 0) + Number(adjSum?.total ?? 0);
        if (lineSum !== billed) {
          res.status(422).json({
            error: 'lines_dont_match_billed',
            lineSum,
            billed,
            delta: billed - lineSum,
          });
          return;
        }
      }
      const patch: Record<string, unknown> = {};
      if (parsed.data.invoiceDescription !== undefined) {
        patch['invoiceDescription'] = parsed.data.invoiceDescription;
      }
      if (parsed.data.invoiceLineItems !== undefined) {
        patch['invoiceLineItems'] = parsed.data.invoiceLineItems;
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db.update(billingBatches).set(patch).where(eq(billingBatches.id, batch.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'billing_batch_invoice_composition',
        entityId: batch.id,
        actorAppUserId: session.appUserId,
        after: patch,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
