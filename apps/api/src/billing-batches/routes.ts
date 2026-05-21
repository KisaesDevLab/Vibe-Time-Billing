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
  appUsers,
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
import { renderHtmlToPdf } from '../pdf/render';

export interface BillingBatchRoutesDeps extends RbacDeps {
  db: Database | null;
  // Phase 11 #9 — wired for emailable pre-bill.
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
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

      // NTE cap check (Phase 11 #18): if the engagement has a per-period
      // NTE, reject the batch when its included entries would exceed it.
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
            capCents: Number(eng.nteCapCents),
            projectedCents,
          });
          return;
        }
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
