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
  dunningHistory,
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
import { getBillingContact } from '../clients/billing-contact';
import { recordOutbound } from '../clients/communications';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { excelTable } from '../reports/excel';
import { publishWebhookEvent } from '../webhooks/publish';

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
  // Phase 12 #19 — optional link to the adjustment that triggered this
  // credit memo. Recorded in audit log + invoice notes so reverse
  // lookups work (admin search by adjustmentId).
  adjustmentId: z.string().uuid().optional(),
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
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'invoice:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const q = String(req.query['q'] ?? '').trim();
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
    const clientId = typeof req.query['clientId'] === 'string' ? req.query['clientId'] : null;
    const conds = [eq(invoices.firmId, session.firmId)];
    if (q) {
      const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
      // Phase 13 #22 — broaden the free-text reach to invoice notes
      // and id-prefix lookups so partners can paste any visible string
      // and have it resolve.
      const search = or(
        ilike(invoices.invoiceNumber, like),
        ilike(clients.name, like),
        ilike(invoices.notes, like),
      );
      if (search) conds.push(search);
    }
    if (
      status === 'DRAFT' ||
      status === 'SENT' ||
      status === 'PARTIALLY_PAID' ||
      status === 'PAID' ||
      status === 'OVERDUE' ||
      status === 'VOIDED'
    ) {
      conds.push(eq(invoices.status, status));
    }
    if (clientId) conds.push(eq(invoices.clientId, clientId));
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

  router.get(
    '/export.csv',
    requirePermission(deps, 'invoice:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.send('id,invoiceNumber,status\n');
        return;
      }
      const items = await deps.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          clientName: clients.name,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
          status: invoices.status,
        })
        .from(invoices)
        .innerJoin(clients, eq(clients.id, invoices.clientId))
        .where(eq(invoices.firmId, session.firmId))
        .orderBy(desc(invoices.issueDate))
        .limit(10000);
      const format = String(req.query['format'] ?? '').toLowerCase();
      const dateStr = new Date().toISOString().slice(0, 10);
      if (format === 'xlsx' || format === 'xls' || format === 'excel') {
        const sheet = excelTable<(typeof items)[number]>({
          title: `Invoices ${dateStr}`,
          columns: [
            { header: 'Invoice', render: (i) => i.invoiceNumber },
            { header: 'Client', render: (i) => i.clientName },
            { header: 'Issued', render: (i) => i.issueDate ?? '' },
            { header: 'Due', render: (i) => i.dueDate ?? '' },
            { header: 'Total', render: (i) => Number(i.totalCents) / 100, numeric: true },
            { header: 'Paid', render: (i) => Number(i.paidCents) / 100, numeric: true },
            {
              header: 'Balance',
              render: (i) => (Number(i.totalCents) - Number(i.paidCents)) / 100,
              numeric: true,
            },
            { header: 'Status', render: (i) => i.status },
          ],
          rows: items,
        });
        res.setHeader('Content-Type', sheet.mime);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="invoices-${dateStr}.${sheet.ext}"`,
        );
        res.send(sheet.body);
        return;
      }
      const header = [
        'id',
        'invoiceNumber',
        'clientName',
        'issueDate',
        'dueDate',
        'totalCents',
        'paidCents',
        'balanceCents',
        'status',
      ];
      const lines = [header.join(',')];
      for (const inv of items) {
        const balance = Number(inv.totalCents) - Number(inv.paidCents);
        lines.push(
          [
            inv.id,
            inv.invoiceNumber,
            csvStr(inv.clientName),
            inv.issueDate,
            inv.dueDate,
            String(inv.totalCents),
            String(inv.paidCents),
            String(balance),
            inv.status,
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="invoices-${dateStr}.csv"`);
      res.send(lines.join('\n') + '\n');
    },
  );

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

      // Aggregate INCLUDED time entry amounts, split by in_scope_flag so
      // mixed-mode subscriptions can compose retainer + overage as two
      // line items below (Phase 10 #10/#11).
      const includedSplit = await deps.db
        .select({
          inScope: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntries.inScopeFlag} THEN ${timeEntries.standardAmountCents} ELSE 0 END), 0)`,
          overage: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntries.inScopeFlag} THEN 0 ELSE ${timeEntries.standardAmountCents} END), 0)`,
          inScopeHours: sql<string>`COALESCE(SUM(CASE WHEN ${timeEntries.inScopeFlag} THEN ${timeEntries.hours} ELSE 0 END), 0)`,
          overageHours: sql<string>`COALESCE(SUM(CASE WHEN ${timeEntries.inScopeFlag} THEN 0 ELSE ${timeEntries.hours} END), 0)`,
        })
        .from(billingBatchEntries)
        .innerJoin(timeEntries, eq(timeEntries.id, billingBatchEntries.timeEntryId))
        .where(
          and(
            eq(billingBatchEntries.billingBatchId, batch.id),
            eq(billingBatchEntries.action, 'INCLUDE'),
          ),
        );
      const inScopeAmount = Number(includedSplit[0]?.inScope ?? 0);
      const overageAmount = Number(includedSplit[0]?.overage ?? 0);
      const overageHours = Number(includedSplit[0]?.overageHours ?? 0);
      const includedTotal = inScopeAmount + overageAmount;

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

      // Phase 10 #10/#11 — mixed-mode invoice composer.
      // For RECURRING_SUBSCRIPTION engagements with mixedModeEnabled=true,
      // produce two lines: the retainer (engagement.feeAmountCents as
      // RECURRING_FEE) and any out-of-scope hours rolled up as overage
      // (TIME_AGGREGATE). In-scope hours are absorbed by the retainer
      // (and already debited from the hour-bank if one exists).
      // Adjustments still net into the OOS lane since in-scope WIP is
      // not separately billed.
      const isMixedMode = eng.mixedModeEnabled && eng.feeStructure === 'RECURRING_SUBSCRIPTION';
      const lines: LineItem[] = isMixedMode
        ? (() => {
            const out: LineItem[] = [];
            if (eng.feeAmountCents && Number(eng.feeAmountCents) > 0) {
              out.push({
                kind: 'RECURRING_FEE',
                description: `${eng.name} — retainer · ${batch.periodStart} to ${batch.periodEnd}`,
                amountCents: Number(eng.feeAmountCents),
              });
            }
            const overageLineAmount = overageAmount + adjTotal;
            if (overageLineAmount !== 0 || overageHours > 0) {
              out.push({
                kind: 'TIME_AGGREGATE',
                description: `Out-of-scope overage — ${overageHours.toFixed(2)}h`,
                amountCents: overageLineAmount,
              });
            }
            return out;
          })()
        : [
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
      const [branding] = await deps.db
        .select({
          displayName: firmSettings.brandDisplayName,
          logoUrl: firmSettings.brandLogoUrl,
          accentColor: firmSettings.brandAccentColor,
          supportEmail: firmSettings.brandSupportEmail,
          supportPhone: firmSettings.brandSupportPhone,
          footerHtml: firmSettings.brandFooterHtml,
          templateStyle: firmSettings.invoiceTemplateStyle,
        })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, inv.firmId))
        .limit(1);
      const [client] = await deps.db
        .select({ name: clients.name, billingAddress: clients.billingAddress })
        .from(clients)
        .where(eq(clients.id, inv.clientId))
        .limit(1);
      const rawLines = await deps.db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, inv.id))
        .orderBy(invoiceLineItems.sortOrder);

      // Mode picker — Phase 13 #9. Three modes:
      //   summary       — single aggregate line per kind
      //   by-line       — original line items (default)
      //   full-detail   — line items + a footer listing the time-entry breakdown
      const mode = typeof req.query['mode'] === 'string' ? req.query['mode'] : 'by-line';
      let lines = rawLines;
      let detailFooter: string | null = null;
      if (mode === 'summary') {
        const byKind = new Map<string, number>();
        for (const l of rawLines) {
          byKind.set(l.kind, (byKind.get(l.kind) ?? 0) + Number(l.amountCents));
        }
        lines = Array.from(byKind.entries()).map(([kind, amount], i) => ({
          ...rawLines[0]!,
          id: `summary-${i}`,
          kind: kind as (typeof rawLines)[number]['kind'],
          description: kind.replace(/_/g, ' '),
          amountCents: amount,
          sortOrder: i,
        }));
      } else if (mode === 'full-detail') {
        // Read time entries linked through batch_entry rows.
        const { sql: drz } = await import('drizzle-orm');
        const detail = await deps.db.execute(drz`
          SELECT te.entry_date::text AS d, te.hours, te.description, te.standard_amount_cents AS amt
          FROM time_entry te
          JOIN billing_batch_entry bbe ON bbe.time_entry_id = te.id
          JOIN billing_batch bb ON bb.id = bbe.billing_batch_id
          WHERE bb.engagement_id = ${inv.primaryEngagementId}
          ORDER BY te.entry_date
          LIMIT 500
        `);
        const rows =
          (detail as unknown as { rows?: Array<Record<string, unknown>> }).rows ??
          (detail as unknown as Array<Record<string, unknown>>);
        if (rows && rows.length > 0) {
          detailFooter =
            '<h3 style="margin-top:24px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#666">Time entry detail</h3>' +
            '<table style="width:100%;border-collapse:collapse;font-size:11px"><tr><th style="text-align:left">Date</th><th style="text-align:left">Description</th><th style="text-align:right">Hours</th><th style="text-align:right">Amount</th></tr>' +
            rows
              .map(
                (r) =>
                  `<tr><td>${String(r['d'] ?? '')}</td><td>${String(r['description'] ?? '').slice(0, 80)}</td><td style="text-align:right">${Number(r['hours'] ?? 0).toFixed(2)}</td><td style="text-align:right">$${(Number(r['amt'] ?? 0) / 100).toFixed(2)}</td></tr>`,
              )
              .join('') +
            '</table>';
        }
      }

      const html = renderInvoiceHtml({
        invoiceNumber: inv.invoiceNumber,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        // Phase 13 #6 — firm picks the template style; ?style= override
        // for preview ("preview as classic" without saving).
        style: (() => {
          const q = typeof req.query['style'] === 'string' ? req.query['style'] : null;
          if (q === 'modern' || q === 'classic' || q === 'minimal') return q;
          const s = branding?.templateStyle;
          if (s === 'modern' || s === 'classic' || s === 'minimal') return s;
          return 'modern';
        })(),
        firm: {
          name: branding?.displayName || firm?.name || 'Firm',
          logoUrl: branding?.logoUrl ?? null,
        },
        branding: branding
          ? {
              accentColor: branding.accentColor ?? null,
              supportEmail: branding.supportEmail ?? null,
              supportPhone: branding.supportPhone ?? null,
              footerHtml: branding.footerHtml ?? null,
            }
          : null,
        client: { name: client?.name ?? 'Client', billingAddress: client?.billingAddress ?? null },
        lines: lines.map((l) => ({
          kind: l.kind,
          description: l.description,
          amountCents: Number(l.amountCents),
        })),
        subtotalCents: Number(inv.subtotalCents),
        processingFeeCents: Number(inv.feeCents),
        totalCents: Number(inv.totalCents),
        notes: detailFooter ? `${inv.notes ?? ''}\n\n${detailFooter}` : (inv.notes ?? null),
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
      await publishWebhookEvent(deps.db, session.firmId, 'invoice.sent', {
        invoiceId: req.params['id']!,
        emailedTo: sent.emailedTo,
      }).catch((err: unknown) => logger.error({ err }, 'webhook publish failed'));
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

  // -----------------------------------------------------------------
  // Reopen an invoice as a new draft (Phase 11 #23). Voids the original
  // and creates a fresh DRAFT carrying forward the line items so a partner
  // can re-edit + re-send. Returns the new invoice id.
  // -----------------------------------------------------------------
  router.post(
    '/:id/reopen',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
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
      if (inv.status === 'PAID' || inv.status === 'PARTIALLY_PAID') {
        res.status(409).json({ error: 'cannot_reopen_with_payments', status: inv.status });
        return;
      }
      const oldLines = await deps.db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, inv.id));
      const newId = await deps.db.transaction(async (tx) => {
        await tx.update(invoices).set({ status: 'VOIDED' }).where(eq(invoices.id, inv.id));
        const [created] = await tx
          .insert(invoices)
          .values({
            firmId: inv.firmId,
            clientId: inv.clientId,
            primaryEngagementId: inv.primaryEngagementId,
            invoiceNumber: `${inv.invoiceNumber}-r${Date.now() % 1000}`,
            issueDate: new Date().toISOString().slice(0, 10),
            dueDate: inv.dueDate,
            status: 'DRAFT',
            subtotalCents: inv.subtotalCents,
            feeCents: inv.feeCents,
            totalCents: inv.totalCents,
            paidCents: 0,
            notes: inv.notes ?? null,
          })
          .returning({ id: invoices.id });
        if (!created) throw new Error('reopen_failed');
        for (const l of oldLines) {
          await tx.insert(invoiceLineItems).values({
            invoiceId: created.id,
            kind: l.kind,
            description: l.description,
            amountCents: l.amountCents,
            engagementId: l.engagementId,
            sourceRefType: 'reopen',
            sortOrder: l.sortOrder,
          });
        }
        return created.id;
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'invoice',
        entityId: newId,
        actorAppUserId: session.appUserId,
        after: { kind: 'reopen', from: inv.id },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: newId, voidedOriginal: inv.id });
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
    '/:id/expense',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      // Expense pass-through with markup (Phase 13 #16). Body:
      //   { description, costCents, markupPct (e.g. 10 → +10%), engagementId? }
      // Adds an EXPENSE line item at cost + markup, separately so the
      // client sees the markup transparently.
      const Schema = z.object({
        description: z.string().min(1).max(400),
        costCents: z.number().int().nonnegative(),
        markupPct: z.number().min(0).max(200),
        engagementId: z.string().uuid().optional(),
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
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
      if (inv.status === 'PAID' || inv.status === 'VOIDED') {
        res.status(409).json({ error: 'invoice_immutable' });
        return;
      }
      const markupCents = Math.round((parsed.data.costCents * parsed.data.markupPct) / 100);
      const total = parsed.data.costCents + markupCents;
      const [maxSort] = await deps.db
        .select({ s: sql<number>`COALESCE(MAX(${invoiceLineItems.sortOrder}), 0)` })
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, inv.id));
      const sortOrder = Number(maxSort?.s ?? 0) + 1;
      await deps.db.transaction(async (tx) => {
        await tx.insert(invoiceLineItems).values({
          invoiceId: inv.id,
          kind: 'EXPENSE',
          description: `${parsed.data.description} (cost $${(parsed.data.costCents / 100).toFixed(2)} + ${parsed.data.markupPct}% markup)`,
          amountCents: total,
          engagementId: parsed.data.engagementId ?? null,
          sourceRefType: 'expense',
          sortOrder,
        });
        await tx
          .update(invoices)
          .set({
            subtotalCents: Number(inv.subtotalCents) + total,
            totalCents: Number(inv.totalCents) + total,
          })
          .where(eq(invoices.id, inv.id));
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: inv.id,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'expense_passthrough',
          costCents: parsed.data.costCents,
          markupPct: parsed.data.markupPct,
          totalCents: total,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ ok: true, totalCents: total, markupCents });
    },
  );

  router.post(
    '/:id/line-items',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const parsed = LineItemSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
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
      if (inv.status === 'PAID' || inv.status === 'VOIDED') {
        res.status(409).json({ error: 'invoice_immutable' });
        return;
      }
      const [maxSort] = await deps.db
        .select({ s: sql<number>`COALESCE(MAX(${invoiceLineItems.sortOrder}), 0)` })
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, inv.id));
      const sortOrder = Number(maxSort?.s ?? 0) + 1;
      await deps.db.transaction(async (tx) => {
        await tx.insert(invoiceLineItems).values({
          invoiceId: inv.id,
          kind: parsed.data.kind,
          description: parsed.data.description,
          amountCents: parsed.data.amountCents,
          engagementId: parsed.data.engagementId ?? null,
          sourceRefType: 'manual',
          sortOrder,
        });
        await tx
          .update(invoices)
          .set({
            subtotalCents: Number(inv.subtotalCents) + parsed.data.amountCents,
            totalCents: Number(inv.totalCents) + parsed.data.amountCents,
          })
          .where(eq(invoices.id, inv.id));
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: inv.id,
        actorAppUserId: session.appUserId,
        after: { kind: 'line_item_add', amountCents: parsed.data.amountCents },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ ok: true });
    },
  );

  router.patch(
    '/:id/line-items/:lineItemId',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
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
      if (inv.status === 'PAID' || inv.status === 'VOIDED') {
        res.status(409).json({ error: 'invoice_immutable' });
        return;
      }
      const body = req.body as {
        description?: unknown;
        amountCents?: unknown;
        sortOrder?: unknown;
      };
      const [orig] = await deps.db
        .select()
        .from(invoiceLineItems)
        .where(
          and(
            eq(invoiceLineItems.id, req.params['lineItemId']!),
            eq(invoiceLineItems.invoiceId, inv.id),
          ),
        )
        .limit(1);
      if (!orig) {
        res.status(404).json({ error: 'line_item_not_found' });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (typeof body.description === 'string')
        patch['description'] = body.description.slice(0, 400);
      if (typeof body.sortOrder === 'number') patch['sortOrder'] = body.sortOrder;
      let delta = 0;
      if (typeof body.amountCents === 'number') {
        patch['amountCents'] = body.amountCents;
        delta = body.amountCents - Number(orig.amountCents);
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db.transaction(async (tx) => {
        await tx.update(invoiceLineItems).set(patch).where(eq(invoiceLineItems.id, orig.id));
        if (delta !== 0) {
          await tx
            .update(invoices)
            .set({
              subtotalCents: Number(inv.subtotalCents) + delta,
              totalCents: Number(inv.totalCents) + delta,
            })
            .where(eq(invoices.id, inv.id));
        }
      });
      res.json({ ok: true });
    },
  );

  router.delete(
    '/:id/line-items/:lineItemId',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
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
      if (inv.status === 'PAID' || inv.status === 'VOIDED') {
        res.status(409).json({ error: 'invoice_immutable' });
        return;
      }
      const [line] = await deps.db
        .select()
        .from(invoiceLineItems)
        .where(
          and(
            eq(invoiceLineItems.id, req.params['lineItemId']!),
            eq(invoiceLineItems.invoiceId, inv.id),
          ),
        )
        .limit(1);
      if (!line) {
        res.status(404).json({ error: 'line_item_not_found' });
        return;
      }
      await deps.db.transaction(async (tx) => {
        await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.id, line.id));
        await tx
          .update(invoices)
          .set({
            subtotalCents: Number(inv.subtotalCents) - Number(line.amountCents),
            totalCents: Number(inv.totalCents) - Number(line.amountCents),
          })
          .where(eq(invoices.id, inv.id));
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: inv.id,
        actorAppUserId: session.appUserId,
        after: { kind: 'line_item_remove', lineItemId: line.id, amountCents: line.amountCents },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id/notes',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 2000) : null;
      await deps.db
        .update(invoices)
        .set({ notes })
        .where(and(eq(invoices.id, req.params['id']!), eq(invoices.firmId, session.firmId)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { notesUpdated: true },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.get(
    '/:id/dunning-history',
    requirePermission(deps, 'invoice:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [inv] = await deps.db
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.id, req.params['id']!), eq(invoices.firmId, session.firmId)))
        .limit(1);
      if (!inv) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select()
        .from(dunningHistory)
        .where(eq(dunningHistory.invoiceId, inv.id))
        .orderBy(dunningHistory.sentAt);
      res.json({ items });
    },
  );

  router.post(
    '/:id/mark-paid',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
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
      if (inv.status === 'PAID' || inv.status === 'VOIDED') {
        res.status(409).json({ error: 'invoice_not_payable', status: inv.status });
        return;
      }
      const balance = Number(inv.totalCents) - Number(inv.paidCents);
      const reference =
        typeof req.body?.reference === 'string' ? req.body.reference.slice(0, 200) : null;
      await deps.db.transaction(async (tx) => {
        await tx.insert(payments).values({
          invoiceId: inv.id,
          amountCents: balance,
          feeCents: 0,
          provider: 'MANUAL',
          providerChargeId: reference,
          status: 'SUCCEEDED',
          receivedAt: new Date(),
        });
        await tx
          .update(invoices)
          .set({
            paidCents: Number(inv.totalCents),
            status: 'PAID',
            paidAt: new Date(),
          })
          .where(eq(invoices.id, inv.id));
      });
      await emitAudit(deps.db, {
        action: 'PAYMENT',
        entityType: 'invoice',
        entityId: inv.id,
        actorAppUserId: session.appUserId,
        after: { kind: 'manual_mark_paid', amountCents: balance, reference },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/batch-send',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, sent: 0 });
        return;
      }
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.filter((x: unknown): x is string => typeof x === 'string')
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: 'ids_required' });
        return;
      }
      let sent = 0;
      for (const id of ids) {
        const r = await sendInvoiceEmail(deps, session.firmId, id);
        if (r.ok) {
          await deps.db
            .update(invoices)
            .set({ status: 'SENT', sentAt: new Date() })
            .where(and(eq(invoices.id, id), eq(invoices.firmId, session.firmId)));
          sent++;
        }
      }
      res.json({ ok: true, sent, total: ids.length });
    },
  );

  router.get(
    '/count-by-status',
    requirePermission(deps, 'invoice:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ counts: {} });
        return;
      }
      const rows = await deps.db
        .select({ status: invoices.status, c: sql<number>`COUNT(*)`.as('c') })
        .from(invoices)
        .where(eq(invoices.firmId, session.firmId))
        .groupBy(invoices.status);
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.status] = Number(r.c);
      res.json({ counts });
    },
  );

  router.post(
    '/:id/duplicate',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
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
      const lines = await deps.db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, orig.id));
      const [maxNum] = await deps.db
        .select({
          n: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM '[0-9]+$') AS INTEGER)), 0)`,
        })
        .from(invoices)
        .where(eq(invoices.firmId, session.firmId));
      const issueDate = new Date().toISOString().slice(0, 10);
      const invoiceNumber = formatInvoiceNumber({
        config: { prefix: 'INV', yearPart: 'FOUR_DIGIT' },
        sequence: Number(maxNum?.n ?? 0) + 1,
        issueDate,
      });
      const newId = await deps.db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(invoices)
          .values({
            firmId: orig.firmId,
            clientId: orig.clientId,
            primaryEngagementId: orig.primaryEngagementId,
            invoiceNumber,
            issueDate,
            dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
            subtotalCents: orig.subtotalCents,
            feeCents: orig.feeCents,
            totalCents: orig.totalCents,
            status: 'DRAFT',
            notes: orig.notes,
          })
          .returning({ id: invoices.id });
        if (!inv) throw new Error('duplicate failed');
        if (lines.length > 0) {
          await tx.insert(invoiceLineItems).values(
            lines.map((l, i) => ({
              invoiceId: inv.id,
              kind: l.kind,
              description: l.description,
              amountCents: l.amountCents,
              engagementId: l.engagementId,
              sourceRefType: 'duplicate',
              sortOrder: i,
            })),
          );
        }
        return inv.id;
      });
      res.status(201).json({ id: newId, invoiceNumber });
    },
  );

  router.post(
    '/:id/dunning',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [inv] = await deps.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
          dueDate: invoices.dueDate,
          status: invoices.status,
          clientId: invoices.clientId,
        })
        .from(invoices)
        .where(and(eq(invoices.id, req.params['id']!), eq(invoices.firmId, session.firmId)))
        .limit(1);
      if (!inv) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (inv.status === 'PAID' || inv.status === 'VOIDED') {
        res.status(409).json({ error: 'invoice_not_collectible', status: inv.status });
        return;
      }
      const [client] = await deps.db
        .select({ name: clients.name })
        .from(clients)
        .where(eq(clients.id, inv.clientId))
        .limit(1);
      const billingContact = await getBillingContact(deps.db, inv.clientId);
      if (!deps.sendEmail || !billingContact?.email) {
        res.status(409).json({ error: 'no_email_destination' });
        return;
      }
      void client;
      const balance = Number(inv.totalCents) - Number(inv.paidCents);
      const link = deps.portalBaseUrl ? `${deps.portalBaseUrl}/invoices/${inv.id}` : '';
      const body =
        `Friendly reminder: invoice ${inv.invoiceNumber} for ` +
        `$${(balance / 100).toFixed(2)} was due ${inv.dueDate}.\n\n` +
        (link ? `View/pay: ${link}\n\n` : '') +
        `Please reach out if you have any questions.`;
      try {
        await deps.sendEmail({
          to: billingContact.email,
          subject: `Reminder: invoice ${inv.invoiceNumber}`,
          body,
        });
      } catch (err) {
        res.status(502).json({ error: 'email_dispatch_failed' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: inv.id,
        actorAppUserId: session.appUserId,
        after: { kind: 'manual_dunning', sentTo: billingContact.email },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, sentTo: billingContact.email });
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
            notes:
              `Credit memo against ${orig.invoiceNumber}. Reason: ${parsed.data.reason}` +
              (parsed.data.adjustmentId ? ` [adjustment: ${parsed.data.adjustmentId}]` : ''),
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
          adjustmentId: parsed.data.adjustmentId ?? null,
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

  // -----------------------------------------------------------------
  // Mark many invoices PAID at once (manual reconciliation).
  // -----------------------------------------------------------------
  router.post(
    '/bulk-mark-paid',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ updated: 0 });
        return;
      }
      const body = req.body as { invoiceIds?: unknown };
      const ids = Array.isArray(body.invoiceIds)
        ? body.invoiceIds.filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: 'invoiceIds_required' });
        return;
      }
      const rows = await deps.db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            sql`${invoices.id} = ANY(ARRAY[${sql.join(
              ids.map((i) => sql`${i}`),
              sql`,`,
            )}]::uuid[])`,
          ),
        );
      let updated = 0;
      for (const inv of rows) {
        if (inv.status === 'PAID' || inv.status === 'VOIDED') continue;
        await deps.db
          .update(invoices)
          .set({
            status: 'PAID',
            paidCents: inv.totalCents,
            paidAt: new Date(),
          })
          .where(eq(invoices.id, inv.id));
        updated++;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice_bulk',
        actorAppUserId: session.appUserId,
        after: { kind: 'bulk_mark_paid', count: updated },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ updated });
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
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, inv.clientId))
    .limit(1);
  if (!client) return { ok: false, status: 404, error: 'client_not_found' };
  const billingContact = await getBillingContact(deps.db, inv.clientId);
  if (!deps.sendEmail || !billingContact?.email) {
    // Mark sent even without dispatcher — caller still flips status.
    return { ok: true, emailedTo: billingContact?.email ?? null };
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
  const subject = `Invoice ${inv.invoiceNumber}`;
  try {
    await deps.sendEmail({ to: billingContact.email, subject, body });
    await recordOutbound({
      db: deps.db,
      firmId,
      clientId: inv.clientId,
      channel: 'EMAIL',
      subject,
      body,
      relatedEntityType: 'invoice',
      relatedEntityId: inv.id,
    }).catch((err) => logger.warn({ err }, 'comms record failed'));
  } catch (err) {
    logger.error({ err, invoiceId: inv.id }, 'invoice email dispatch failed');
    return { ok: false, status: 502, error: 'email_dispatch_failed' };
  }
  return { ok: true, emailedTo: billingContact.email };
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

function csvStr(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Reference to firmSettings to avoid unused-import warning — used in
// future revision when the numbering config is per-firm-configurable.
void firmSettings;
