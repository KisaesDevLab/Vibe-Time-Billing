// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Invoice endpoints (Phase 13). Generates an invoice from an approved
// billing batch by aggregating the included time entries net of any
// adjustments. Numbering uses @vibe/core/invoicing.formatInvoiceNumber.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  adjustmentAllocations,
  adjustments,
  billingBatchEntries,
  billingBatches,
  clients,
  engagements,
  firmSettings,
  firms,
  invoiceLineItems,
  invoices,
  timeEntries,
} from '@vibe/db/schema';
import {
  computeTotals,
  formatInvoiceNumber,
  renderInvoiceHtml,
  type LineItem,
  type NumberingConfig,
} from '@vibe/core/invoicing';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface InvoiceRoutesDeps extends RbacDeps {
  db: Database | null;
}

const GenerateSchema = z.object({
  billingBatchId: z.string().uuid(),
});

export function createInvoiceRouter(deps: InvoiceRoutesDeps): Router {
  const router = express.Router();

  router.get('/', requirePermission(deps, 'invoice:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        clientId: invoices.clientId,
        clientName: clients.name,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        totalCents: invoices.totalCents,
        paidCents: invoices.paidCents,
        status: invoices.status,
        firstViewedAt: invoices.firstViewedAt,
      })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(eq(invoices.firmId, session.firmId))
      .orderBy(desc(invoices.issueDate))
      .limit(500);
    res.json({ items });
  });

  router.post(
    '/generate-from-batch',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const parsed = GenerateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }

      const [batch] = await deps.db
        .select()
        .from(billingBatches)
        .where(eq(billingBatches.id, parsed.data.billingBatchId))
        .limit(1);
      if (!batch) {
        res.status(404).json({ error: 'batch_not_found' });
        return;
      }
      if (batch.status !== 'APPROVED' && batch.status !== 'IN_REVIEW') {
        res.status(409).json({ error: 'batch_not_approved' });
        return;
      }

      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, batch.engagementId))
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

      // Aggregate INCLUDED time entry amounts.
      const includedRows = await deps.db
        .select({
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
        })
        .from(billingBatchEntries)
        .innerJoin(timeEntries, eq(timeEntries.id, billingBatchEntries.timeEntryId))
        .where(
          and(
            eq(billingBatchEntries.billingBatchId, batch.id),
            eq(billingBatchEntries.action, 'INCLUDE'),
          ),
        );
      const includedTotal = Number(includedRows[0]?.amountCents ?? 0);

      // Net of any APPLIED adjustments against this batch.
      const adjRows = await deps.db
        .select({
          adj: sql<number>`COALESCE(SUM(${adjustmentAllocations.adjustmentAmountCents}), 0)`,
        })
        .from(adjustmentAllocations)
        .innerJoin(adjustments, eq(adjustments.id, adjustmentAllocations.adjustmentId))
        .where(and(eq(adjustments.billingBatchId, batch.id), eq(adjustments.status, 'APPLIED')));
      const adjTotal = Number(adjRows[0]?.adj ?? 0);
      const lineAmount = includedTotal + adjTotal;

      // Numbering — bump a per-firm sequence (simple max + 1; for atomicity
      // a real install adds a Postgres sequence, but the unique index on
      // (firm_id, invoice_number) catches collisions either way).
      const [maxNum] = await deps.db
        .select({
          n: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM '[0-9]+$') AS INTEGER)), 0)`,
        })
        .from(invoices)
        .where(eq(invoices.firmId, session.firmId));
      const sequence = Number(maxNum?.n ?? 0) + 1;
      const numbering: NumberingConfig = { prefix: 'INV', yearPart: 'FOUR_DIGIT' };
      const issueDate = new Date().toISOString().slice(0, 10);
      const dueDate = new Date(Date.now() + client.termsDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const invoiceNumber = formatInvoiceNumber({
        config: numbering,
        sequence,
        issueDate,
      });

      const lines: LineItem[] = [
        {
          kind: 'TIME_AGGREGATE',
          description: `${eng.name} — ${batch.periodStart} to ${batch.periodEnd}`,
          amountCents: lineAmount,
        },
      ];
      const totals = computeTotals(lines);

      const invoiceId = await deps.db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(invoices)
          .values({
            firmId: session.firmId,
            clientId: client.id,
            primaryEngagementId: eng.id,
            invoiceNumber,
            issueDate,
            dueDate,
            subtotalCents: totals.subtotalCents,
            feeCents: totals.processingFeeCents,
            totalCents: totals.totalCents,
            status: 'DRAFT',
          })
          .returning({ id: invoices.id });
        if (!inv) throw new Error('invoice insert failed');

        await tx.insert(invoiceLineItems).values(
          lines.map((l, i) => ({
            invoiceId: inv.id,
            kind: l.kind,
            description: l.description,
            amountCents: l.amountCents,
            engagementId: eng.id,
            sourceRefType: 'billing_batch',
            sourceRefId: batch.id,
            sortOrder: i,
          })),
        );
        // Advance batch to INVOICED
        await tx
          .update(billingBatches)
          .set({ status: 'INVOICED' })
          .where(eq(billingBatches.id, batch.id));
        return inv.id;
      });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'invoice',
        entityId: invoiceId,
        actorAppUserId: session.appUserId,
        after: { invoiceNumber, totalCents: totals.totalCents },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.status(201).json({ id: invoiceId, invoiceNumber, totalCents: totals.totalCents });
    },
  );

  router.get(
    '/:id',
    requirePermission(deps, 'invoice:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ invoice: null, lineItems: [] });
        return;
      }
      const [inv] = await deps.db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, req.params['id']!), eq(invoices.firmId, session.firmId)))
        .limit(1);
      if (!inv) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const lines = await deps.db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, inv.id))
        .orderBy(invoiceLineItems.sortOrder);
      res.json({ invoice: inv, lineItems: lines });
    },
  );

  router.get(
    '/:id/pdf',
    requirePermission(deps, 'invoice:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [inv] = await deps.db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, req.params['id']!), eq(invoices.firmId, session.firmId)))
        .limit(1);
      if (!inv) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [firm] = await deps.db
        .select({ name: firms.name })
        .from(firms)
        .where(eq(firms.id, inv.firmId))
        .limit(1);
      const [client] = await deps.db
        .select({ name: clients.name, billingAddress: clients.billingAddress })
        .from(clients)
        .where(eq(clients.id, inv.clientId))
        .limit(1);
      const lines = await deps.db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, inv.id))
        .orderBy(invoiceLineItems.sortOrder);

      const html = renderInvoiceHtml({
        invoiceNumber: inv.invoiceNumber,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        firm: { name: firm?.name ?? 'Firm' },
        client: { name: client?.name ?? 'Client', billingAddress: client?.billingAddress ?? null },
        lines: lines.map((l) => ({
          kind: l.kind,
          description: l.description,
          amountCents: Number(l.amountCents),
        })),
        subtotalCents: Number(inv.subtotalCents),
        processingFeeCents: Number(inv.feeCents),
        totalCents: Number(inv.totalCents),
        notes: inv.notes ?? null,
      });

      const accept = req.header('accept') ?? '';
      if (accept.includes('text/html')) {
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
        return;
      }

      // Lazy-load puppeteer so dev environments without Chromium still boot.
      try {
        const { renderHtmlToPdf } = await import('../pdf/render');
        const pdf = await renderHtmlToPdf(html);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${inv.invoiceNumber}.pdf"`);
        res.send(pdf);
      } catch (err) {
        logger.error({ err }, 'pdf render failed');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      }
    },
  );

  router.post(
    '/:id/send',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(invoices)
        .set({ status: 'SENT', sentAt: new Date() })
        .where(and(eq(invoices.id, req.params['id']!), eq(invoices.firmId, session.firmId)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: 'SENT' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

// Reference to firmSettings to avoid unused-import warning — used in
// future revision when the numbering config is per-firm-configurable.
void firmSettings;
