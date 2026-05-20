// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Invoice endpoints (Phase 13). Generates an invoice from an approved
// billing batch by aggregating the included time entries net of any
// adjustments. Numbering uses @vibe/core/invoicing.formatInvoiceNumber.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';

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
  payments,
  timeEntries,
} from '@vibe/db/schema';
import {
  computeTotals,
  formatInvoiceNumber,
  renderInvoiceHtml,
  type LineItem,
  type NumberingConfig,
} from '@vibe/core/invoicing';
import type { PaymentProvider } from '@vibe/core/payments';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface InvoiceRoutesDeps extends RbacDeps {
  db: Database | null;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  portalBaseUrl?: string;
  paymentProvider?: PaymentProvider | null;
}

const GenerateSchema = z.object({
  billingBatchId: z.string().uuid(),
});

const VoidSchema = z.object({
  reason: z.string().min(1).max(400),
});

const RefundSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  reason: z.string().max(400).optional(),
});

const CreditMemoSchema = z.object({
  amountCents: z.number().int().positive(),
  reason: z.string().min(1).max(400),
});

const LineItemSchema = z.object({
  kind: z.enum([
    'TIME_AGGREGATE',
    'FIXED_FEE',
    'MILESTONE',
    'RECURRING_FEE',
    'EXPENSE',
    'PROCESSING_FEE',
    'CUSTOM',
  ]),
  description: z.string().min(1).max(400),
  amountCents: z.number().int(),
  engagementId: z.string().uuid().optional(),
});

const ManualComposeSchema = z.object({
  clientId: z.string().uuid(),
  primaryEngagementId: z.string().uuid().optional(),
  issueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(LineItemSchema).min(1).max(200),
});

export function createInvoiceRouter(deps: InvoiceRoutesDeps): Router {
  const router = express.Router();

  router.get('/', requirePermission(deps, 'invoice:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const q = String(req.query['q'] ?? '').trim();
    const conds = [eq(invoices.firmId, session.firmId)];
    if (q) {
      const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
      const search = or(ilike(invoices.invoiceNumber, like), ilike(clients.name, like));
      if (search) conds.push(search);
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
      .where(and(...conds))
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
      const sent = await sendInvoiceEmail(deps, session.firmId, req.params['id']!);
      if (!sent.ok) {
        res.status(sent.status).json({ error: sent.error });
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
        after: { status: 'SENT', emailedTo: sent.emailedTo },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, emailedTo: sent.emailedTo });
    },
  );

  router.post(
    '/:id/resend',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const sent = await sendInvoiceEmail(deps, session.firmId, req.params['id']!);
      if (!sent.ok) {
        res.status(sent.status).json({ error: sent.error });
        return;
      }
      await deps.db
        .update(invoices)
        .set({ sentAt: new Date() })
        .where(and(eq(invoices.id, req.params['id']!), eq(invoices.firmId, session.firmId)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { resent: true, emailedTo: sent.emailedTo },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, emailedTo: sent.emailedTo });
    },
  );

  router.post(
    '/:id/void',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const parsed = VoidSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [inv] = await deps.db
        .select({ status: invoices.status, paidCents: invoices.paidCents })
        .from(invoices)
        .where(and(eq(invoices.id, req.params['id']!), eq(invoices.firmId, session.firmId)))
        .limit(1);
      if (!inv) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (inv.status === 'VOIDED') {
        res.status(409).json({ error: 'already_voided' });
        return;
      }
      if (Number(inv.paidCents) > 0) {
        res.status(409).json({ error: 'cannot_void_with_payments' });
        return;
      }
      await deps.db
        .update(invoices)
        .set({
          status: 'VOIDED',
          voidedAt: new Date(),
          voidedReason: parsed.data.reason,
        })
        .where(and(eq(invoices.id, req.params['id']!), eq(invoices.firmId, session.firmId)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: 'VOIDED', reason: parsed.data.reason },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/refund',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const parsed = RefundSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
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
      // Pick the most recent SUCCEEDED payment with a provider charge id.
      const [pay] = await deps.db
        .select()
        .from(payments)
        .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, 'SUCCEEDED')))
        .orderBy(desc(payments.receivedAt))
        .limit(1);
      if (!pay) {
        res.status(409).json({ error: 'no_refundable_payment' });
        return;
      }
      const alreadyRefunded = Number(pay.refundedAmountCents ?? 0);
      const refundable = Number(pay.amountCents) - alreadyRefunded;
      if (refundable <= 0) {
        res.status(409).json({ error: 'fully_refunded' });
        return;
      }
      const amount = parsed.data.amountCents ?? refundable;
      if (amount > refundable) {
        res.status(400).json({ error: 'amount_exceeds_refundable', refundable });
        return;
      }

      let providerRefundId: string | undefined;
      if (deps.paymentProvider && pay.providerChargeId) {
        try {
          const r = await deps.paymentProvider.refund({
            providerChargeId: pay.providerChargeId,
            amountCents: amount,
          });
          if (!r.ok) {
            res.status(502).json({ error: 'provider_refund_failed' });
            return;
          }
          providerRefundId = r.providerRefundId;
        } catch (err) {
          logger.error({ err, invoiceId: inv.id }, 'refund provider call errored');
          res.status(502).json({ error: 'provider_refund_errored' });
          return;
        }
      }

      const newRefunded = alreadyRefunded + amount;
      const fullyRefunded = newRefunded >= Number(pay.amountCents);
      await deps.db.transaction(async (tx) => {
        await tx
          .update(payments)
          .set({
            refundedAmountCents: newRefunded,
            refundedAt: new Date(),
            status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          })
          .where(eq(payments.id, pay.id));
        const newPaid = Math.max(0, Number(inv.paidCents) - amount);
        const newInvStatus =
          newPaid <= 0 ? 'SENT' : newPaid >= Number(inv.totalCents) ? 'PAID' : 'PARTIALLY_PAID';
        await tx
          .update(invoices)
          .set({
            paidCents: newPaid,
            status: newInvStatus,
            paidAt: newInvStatus === 'PAID' ? inv.paidAt : null,
          })
          .where(eq(invoices.id, inv.id));
      });

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: inv.id,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'refund',
          amountCents: amount,
          providerRefundId,
          reason: parsed.data.reason,
          paymentId: pay.id,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.json({ ok: true, amountCents: amount, providerRefundId });
    },
  );

  router.post(
    '/:id/credit-memo',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const parsed = CreditMemoSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [orig] = await deps.db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, req.params['id']!), eq(invoices.firmId, session.firmId)))
        .limit(1);
      if (!orig) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [client] = await deps.db
        .select()
        .from(clients)
        .where(eq(clients.id, orig.clientId))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const [maxNum] = await deps.db
        .select({
          n: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM '[0-9]+$') AS INTEGER)), 0)`,
        })
        .from(invoices)
        .where(eq(invoices.firmId, session.firmId));
      const sequence = Number(maxNum?.n ?? 0) + 1;
      const issueDate = new Date().toISOString().slice(0, 10);
      const memoNumber = formatInvoiceNumber({
        config: { prefix: 'CM', yearPart: 'FOUR_DIGIT' },
        sequence,
        issueDate,
      });
      const memoAmount = -Math.abs(parsed.data.amountCents);
      const memoId = await deps.db.transaction(async (tx) => {
        const [memo] = await tx
          .insert(invoices)
          .values({
            firmId: session.firmId,
            clientId: orig.clientId,
            primaryEngagementId: orig.primaryEngagementId,
            invoiceNumber: memoNumber,
            issueDate,
            dueDate: issueDate,
            subtotalCents: memoAmount,
            feeCents: 0,
            totalCents: memoAmount,
            status: 'SENT',
            notes: `Credit memo against ${orig.invoiceNumber}. Reason: ${parsed.data.reason}`,
            sentAt: new Date(),
          })
          .returning({ id: invoices.id });
        if (!memo) throw new Error('credit memo insert failed');
        await tx.insert(invoiceLineItems).values({
          invoiceId: memo.id,
          kind: 'CUSTOM',
          description: `Credit against ${orig.invoiceNumber}: ${parsed.data.reason}`,
          amountCents: memoAmount,
          sortOrder: 0,
        });
        return memo.id;
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'invoice',
        entityId: memoId,
        actorAppUserId: session.appUserId,
        after: {
          memoNumber,
          amountCents: memoAmount,
          againstInvoiceId: orig.id,
          reason: parsed.data.reason,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: memoId, invoiceNumber: memoNumber, totalCents: memoAmount });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const parsed = ManualComposeSchema.safeParse(req.body);
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
        .select()
        .from(clients)
        .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const totals = computeTotals(parsed.data.lines as LineItem[]);
      const [maxNum] = await deps.db
        .select({
          n: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM '[0-9]+$') AS INTEGER)), 0)`,
        })
        .from(invoices)
        .where(eq(invoices.firmId, session.firmId));
      const sequence = Number(maxNum?.n ?? 0) + 1;
      const issueDate = parsed.data.issueDate ?? new Date().toISOString().slice(0, 10);
      const dueDate = new Date(Date.parse(issueDate) + client.termsDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const invoiceNumber = formatInvoiceNumber({
        config: { prefix: 'INV', yearPart: 'FOUR_DIGIT' },
        sequence,
        issueDate,
      });
      const invoiceId = await deps.db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(invoices)
          .values({
            firmId: session.firmId,
            clientId: client.id,
            primaryEngagementId: parsed.data.primaryEngagementId ?? null,
            invoiceNumber,
            issueDate,
            dueDate,
            subtotalCents: totals.subtotalCents,
            feeCents: totals.processingFeeCents,
            totalCents: totals.totalCents,
            status: 'DRAFT',
            notes: parsed.data.notes ?? null,
          })
          .returning({ id: invoices.id });
        if (!inv) throw new Error('invoice insert failed');
        await tx.insert(invoiceLineItems).values(
          parsed.data.lines.map((l, i) => ({
            invoiceId: inv.id,
            kind: l.kind,
            description: l.description,
            amountCents: l.amountCents,
            engagementId: l.engagementId ?? null,
            sourceRefType: 'manual',
            sortOrder: i,
          })),
        );
        return inv.id;
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'invoice',
        entityId: invoiceId,
        actorAppUserId: session.appUserId,
        after: { invoiceNumber, totalCents: totals.totalCents, kind: 'manual' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: invoiceId, invoiceNumber, totalCents: totals.totalCents });
    },
  );

  return router;
}

async function sendInvoiceEmail(
  deps: InvoiceRoutesDeps,
  firmId: string,
  invoiceId: string,
): Promise<{ ok: true; emailedTo: string | null } | { ok: false; status: number; error: string }> {
  if (!deps.db) return { ok: false, status: 503, error: 'db_unavailable' };
  const [inv] = await deps.db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      totalCents: invoices.totalCents,
      dueDate: invoices.dueDate,
      clientId: invoices.clientId,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.firmId, firmId)))
    .limit(1);
  if (!inv) return { ok: false, status: 404, error: 'not_found' };
  const [client] = await deps.db
    .select({ name: clients.name, billingContactEmail: clients.billingContactEmail })
    .from(clients)
    .where(eq(clients.id, inv.clientId))
    .limit(1);
  if (!client) return { ok: false, status: 404, error: 'client_not_found' };
  if (!deps.sendEmail || !client.billingContactEmail) {
    // Mark sent even without dispatcher — caller still flips status.
    return { ok: true, emailedTo: client.billingContactEmail ?? null };
  }
  const portalBase = deps.portalBaseUrl ?? '';
  const link = portalBase ? `${portalBase}/invoices/${inv.id}` : '';
  const total = (Number(inv.totalCents) / 100).toFixed(2);
  const body =
    `Dear ${client.name},\n\n` +
    `Invoice ${inv.invoiceNumber} for $${total} is available. ` +
    `It is due ${inv.dueDate}.\n\n` +
    (link ? `View and pay online: ${link}\n\n` : '') +
    `Thank you.`;
  try {
    await deps.sendEmail({
      to: client.billingContactEmail,
      subject: `Invoice ${inv.invoiceNumber}`,
      body,
    });
  } catch (err) {
    logger.error({ err, invoiceId: inv.id }, 'invoice email dispatch failed');
    return { ok: false, status: 502, error: 'email_dispatch_failed' };
  }
  return { ok: true, emailedTo: client.billingContactEmail };
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

// Reference to firmSettings to avoid unused-import warning — used in
// future revision when the numbering config is per-firm-configurable.
void firmSettings;
