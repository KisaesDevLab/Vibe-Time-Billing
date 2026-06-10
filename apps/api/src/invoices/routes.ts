// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Invoice endpoints (Phase 13). Generates an invoice from an approved
// billing batch by aggregating the included time entries net of any
// adjustments. Numbering uses @vibe/core/invoicing.formatInvoiceNumber.

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  adjustmentAllocations,
  adjustments,
  billingBatchEngagements,
  billingBatchEntries,
  billingBatches,
  clients,
  dunningHistory,
  engagements,
  firmRetainerSettings,
  firmSettings,
  firms,
  invoiceLineItems,
  invoiceReminderLog,
  invoices,
  payments,
  timeEntries,
} from '@vibe/db/schema';
import {
  computeTotals,
  formatInvoiceNumber,
  renderInvoiceHtml,
  salesTaxLine,
  surchargeLine,
  type LineItem,
  type NumberingConfig,
} from '@vibe/core/invoicing';
import type { PaymentProvider } from '@vibe/core/payments';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { maybeCreateRetainerOffer } from '../retainers/offers';
import { getBillingContact } from '../clients/billing-contact';
import { recordOutbound } from '../clients/communications';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';
import { excelTable } from '../reports/excel';
import { publishWebhookEvent } from '../webhooks/publish';

export interface InvoiceRoutesDeps extends RbacDeps {
  db: Database | null;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  // SMS dispatcher — wired from app.ts's sendPortalSms. Used by
  // POST /invoices/:id/send-sms so staff can text the client a
  // notification with the portal link. Optional; the endpoint
  // returns 503 if the provider isn't configured.
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
  portalBaseUrl?: string;
  paymentProvider?: PaymentProvider | null;
  // Stage 1B — step-up gate for void/refund actions. Optional so tests
  // can mount the router without an auth stack.
  requireStepUp?: (req: Request, res: Response, next: NextFunction) => unknown;
}

const GenerateSchema = z.object({
  billingBatchId: z.string().uuid(),
  // R2 — retainer addendum hook. When `enabled` is true (default from
  // firm_retainer_settings.default_biller_toggle_on at the UI layer),
  // attempt to auto-create a retainer offer inside the same transaction.
  // Suppression rules in offers.ts decide whether an offer actually
  // lands; missing options block defaults to enabled=true so legacy
  // callers preserve behavior when the feature is firm-disabled.
  retainerOptions: z
    .object({
      enabled: z.boolean(),
      overrides: z
        .object({
          tier1PriceCents: z.number().int().nonnegative().optional(),
          tier2PriceCents: z.number().int().nonnegative().optional(),
          tier1WorkCodeIds: z.array(z.string().uuid()).optional(),
          tier2WorkCodeIds: z.array(z.string().uuid()).optional(),
        })
        .optional(),
    })
    .optional(),
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
  // Optional — null accepted from FE when the invoice isn't pinned
  // to a single engagement (consolidated invoice path). Treated as
  // undefined downstream.
  engagementId: z.string().uuid().nullable().optional(),
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

// =====================================================================
// Edit helpers — used by the line-item POST/PATCH/DELETE routes and
// the reopen route. Centralizes the "is this invoice editable" gate
// (paidCents === 0 && status !== VOIDED) and re-derives the tax +
// surcharge lines from the engagement's current config after any line
// change. Without the recompute, an invoice with tax/surcharge would
// drift out of sync after a manual edit.
// =====================================================================

type InvoiceRow = typeof invoices.$inferSelect;

function invoiceLockedReason(inv: InvoiceRow): string | null {
  if (inv.status === 'VOIDED') return 'invoice_voided';
  if (Number(inv.paidCents) > 0) return 'invoice_has_payments';
  return null;
}

async function recomputeInvoiceTotals(tx: Database, invoiceId: string): Promise<void> {
  // QA — take a row-level lock on the invoice so concurrent PATCHes
  // can't race-insert duplicate SURCHARGE/SALES_TAX rows. Under READ
  // COMMITTED (Postgres default), two parallel recomputes would each
  // see no surcharge row (their DELETEs only see committed rows),
  // each insert one, both commit → two SURCHARGE rows. FOR UPDATE
  // forces serialization on the invoice id.
  const [inv] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for('update')
    .limit(1);
  if (!inv) throw new Error('recompute: invoice_not_found');

  // Fetch the engagement's current tax/surcharge config (if invoice is
  // pinned to a single engagement — multi-engagement consolidated invoices
  // have primaryEngagementId set as a convenience pointer).
  let eng: {
    taxEnabled: boolean;
    taxRateBps: number;
    taxLabel: string;
    surchargeEnabled: boolean;
    surchargeType: string;
    surchargeValueBps: number;
    surchargeAmountCents: number;
    surchargeLabel: string | null;
  } | null = null;
  if (inv.primaryEngagementId) {
    const [row] = await tx
      .select({
        taxEnabled: engagements.taxEnabled,
        taxRateBps: engagements.taxRateBps,
        taxLabel: engagements.taxLabel,
        surchargeEnabled: engagements.surchargeEnabled,
        surchargeType: engagements.surchargeType,
        surchargeValueBps: engagements.surchargeValueBps,
        surchargeAmountCents: engagements.surchargeAmountCents,
        surchargeLabel: engagements.surchargeLabel,
      })
      .from(engagements)
      .where(eq(engagements.id, inv.primaryEngagementId))
      .limit(1);
    if (row) eng = row;
  }

  // Drop existing auto-derived rows; we'll re-insert below if the
  // engagement config still calls for them.
  await tx
    .delete(invoiceLineItems)
    .where(
      and(
        eq(invoiceLineItems.invoiceId, invoiceId),
        inArray(invoiceLineItems.kind, ['SURCHARGE', 'SALES_TAX']),
      ),
    );

  // Bucket the surviving rows.
  const baseLines = await tx
    .select({ amountCents: invoiceLineItems.amountCents, kind: invoiceLineItems.kind })
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId));

  let subtotal = 0;
  let processingFee = 0;
  for (const l of baseLines) {
    if (l.kind === 'PROCESSING_FEE') processingFee += Number(l.amountCents);
    else subtotal += Number(l.amountCents);
  }

  async function nextSort(): Promise<number> {
    const [row] = await tx
      .select({ s: sql<number>`COALESCE(MAX(${invoiceLineItems.sortOrder}), 0)` })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));
    return Number(row?.s ?? 0) + 1;
  }

  // Surcharge — derived from the engagement's current config.
  let surchargeAmount = 0;
  if (eng?.surchargeEnabled) {
    const [fs] = await tx
      .select({ defaultSurchargeLabel: firmSettings.defaultSurchargeLabel })
      .from(firmSettings)
      .where(eq(firmSettings.firmId, inv.firmId))
      .limit(1);
    const label = eng.surchargeLabel ?? fs?.defaultSurchargeLabel ?? 'Surcharge';
    const line = surchargeLine({
      subtotalCents: subtotal,
      type: eng.surchargeType as 'PERCENT' | 'FLAT_AMOUNT',
      valueBps: eng.surchargeValueBps,
      amountCents: Number(eng.surchargeAmountCents),
      label,
    });
    if (line) {
      await tx.insert(invoiceLineItems).values({
        invoiceId,
        kind: 'SURCHARGE',
        description: line.description,
        amountCents: line.amountCents,
        engagementId: inv.primaryEngagementId,
        sourceRefType: 'auto',
        sortOrder: await nextSort(),
      });
      surchargeAmount = line.amountCents;
    }
  }

  // Tax — computed against subtotal + surcharge (locked decision).
  let taxAmount = 0;
  if (eng?.taxEnabled && eng.taxRateBps > 0) {
    const line = salesTaxLine({
      taxBaseCents: subtotal + surchargeAmount,
      rateBps: eng.taxRateBps,
      label: eng.taxLabel,
    });
    if (line) {
      await tx.insert(invoiceLineItems).values({
        invoiceId,
        kind: 'SALES_TAX',
        description: line.description,
        amountCents: line.amountCents,
        engagementId: inv.primaryEngagementId,
        sourceRefType: 'auto',
        sortOrder: await nextSort(),
      });
      taxAmount = line.amountCents;
    }
  }

  await tx
    .update(invoices)
    .set({
      subtotalCents: subtotal,
      surchargeCents: surchargeAmount,
      taxCents: taxAmount,
      feeCents: processingFee,
      totalCents: subtotal + surchargeAmount + taxAmount + processingFee,
    })
    .where(eq(invoices.id, invoiceId));
}

export function createInvoiceRouter(deps: InvoiceRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // Stage 1B — step-up gating for void/refund. Pass-through if no
  // middleware was injected.
  const requireStepUp =
    deps.requireStepUp ?? ((_req: Request, _res: Response, next: NextFunction) => next());

  router.get('/', requirePermission(deps, 'invoice:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const q = String(req.query['q'] ?? '').trim();
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
    const clientId = uuidQueryParam(req.query['clientId']);
    if (clientId === 'invalid') {
      res.status(400).json({ error: 'invalid_client_id' });
      return;
    }
    // 0050 — filter by client owner + date range
    const clientOwnerId = uuidQueryParam(req.query['clientOwnerId']);
    if (clientOwnerId === 'invalid') {
      res.status(400).json({ error: 'invalid_client_owner_id' });
      return;
    }
    const startDate = typeof req.query['startDate'] === 'string' ? req.query['startDate'] : null;
    const endDate = typeof req.query['endDate'] === 'string' ? req.query['endDate'] : null;

    const conds = [eq(invoices.firmId, session.firmId)];
    if (q) {
      const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
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
    if (clientOwnerId) conds.push(eq(clients.partnerInChargeId, clientOwnerId));
    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate))
      conds.push(sql`${invoices.issueDate} >= ${startDate}`);
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate))
      conds.push(sql`${invoices.issueDate} <= ${endDate}`);

    // 0050 — pagination + sort. Legacy shape when `page` isn't provided.
    const paginated = req.query['page'] != null;
    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
    const pageSize = Math.min(
      500,
      Math.max(1, parseInt(String(req.query['pageSize'] ?? '50'), 10) || 50),
    );
    const sortCol = String(req.query['sort'] ?? 'issueDate');
    const sortDir = String(req.query['dir'] ?? 'desc') === 'asc' ? 'asc' : 'desc';
    const sortMap: Record<string, ReturnType<typeof sql>> = {
      invoiceNumber: sql`${invoices.invoiceNumber}`,
      clientName: sql`${clients.name}`,
      issueDate: sql`${invoices.issueDate}`,
      dueDate: sql`${invoices.dueDate}`,
      total: sql`${invoices.totalCents}`,
      paid: sql`${invoices.paidCents}`,
      status: sql`${invoices.status}`,
    };
    const orderExpr = sortMap[sortCol] ?? sortMap['issueDate']!;

    const selectQ = deps.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        clientId: invoices.clientId,
        clientName: clients.name,
        clientOwnerId: clients.partnerInChargeId,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        totalCents: invoices.totalCents,
        paidCents: invoices.paidCents,
        status: invoices.status,
        firstViewedAt: invoices.firstViewedAt,
        // 0050 — most-recent reminder timestamp; UI uses this to render
        // the cooldown state on the Send-reminder button.
        lastReminderAt: sql<string | null>`(
          SELECT MAX(sent_at) FROM invoice_reminder_log
          WHERE invoice_id = ${invoices.id}
        )`,
        // Distinct engagement type names billed on this invoice, comma-joined
        // for the client billing view. Sourced from the invoice's primary
        // engagement (the common single-engagement case) plus any engagements
        // tagged on its line items (multi-engagement invoices).
        engagementTypes: sql<string | null>`(
          SELECT string_agg(DISTINCT et.name, ', ')
          FROM engagement e
          JOIN engagement_type et ON et.id = e.engagement_type_id
          WHERE e.id = ${invoices.primaryEngagementId}
             OR e.id IN (
               SELECT ili.engagement_id FROM invoice_line_item ili
               WHERE ili.invoice_id = ${invoices.id} AND ili.engagement_id IS NOT NULL
             )
        )`,
      })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId));

    if (!paginated) {
      const items = await selectQ
        .where(and(...conds))
        .orderBy(sortDir === 'asc' ? orderExpr : desc(orderExpr))
        .limit(500);
      res.json({ items });
      return;
    }

    const totalRows = await deps.db
      .select({ total: sql<number>`COUNT(*)`.as('total') })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(and(...conds));
    const total = Number(totalRows[0]?.total ?? 0);

    const rows = await selectQ
      .where(and(...conds))
      .orderBy(sortDir === 'asc' ? orderExpr : desc(orderExpr))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    res.json({ rows, items: rows, total, page, pageSize });
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

      // 0086 — load the full engagement set. Single-engagement batches
      // still produce a 1-element list (the batch's primary). The first
      // engagement in ordinal order acts as the "header" engagement for
      // legacy code paths (mixed-mode + surcharge + tax pull off it).
      const engLinks = await deps.db
        .select({ engagementId: billingBatchEngagements.engagementId })
        .from(billingBatchEngagements)
        .where(eq(billingBatchEngagements.billingBatchId, batch.id))
        .orderBy(billingBatchEngagements.ordinal);
      const engIds =
        engLinks.length > 0
          ? engLinks.map((l) => l.engagementId)
          : batch.engagementId
            ? [batch.engagementId]
            : [];
      if (engIds.length === 0) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const engRows = await deps.db
        .select()
        .from(engagements)
        .where(inArray(engagements.id, engIds));
      if (engRows.length !== engIds.length) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      // Preserve pick order.
      const engById = new Map(engRows.map((r) => [r.id, r]));
      const engsInOrder = engIds.map((id) => engById.get(id)!);
      const eng = engsInOrder[0]!; // "primary" — used for surcharge/tax/mixed-mode config
      const isMultiEngagement = engsInOrder.length > 1;
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

      // 0052 — if the batch carries an invoice composition (line items
      // user-defined via the batch editor), use those verbatim. We
      // re-verify the sum equals the current billed total so a race
      // with later actions can't ship a mismatched invoice.
      const savedLines = batch.invoiceLineItems ?? null;
      let lines: LineItem[];
      // 0086 — parallel array to `lines` carrying each line's
      // engagement_id. For single-engagement batches every entry is
      // the primary engagement; for multi-engagement we tag each
      // TIME_AGGREGATE line with the engagement it summarizes, and
      // surcharge/tax lines (if any) carry the primary engagement.
      let lineEngagementIds: Array<string | null>;
      if (savedLines && savedLines.length > 0) {
        const savedSum = savedLines.reduce((s, l) => s + l.amountCents, 0);
        if (savedSum !== lineAmount) {
          res.status(422).json({
            error: 'invoice_lines_mismatch',
            savedSum,
            billed: lineAmount,
            delta: lineAmount - savedSum,
          });
          return;
        }
        lines = savedLines.map((l) => ({
          kind: 'CUSTOM' as const,
          description: l.description,
          amountCents: l.amountCents,
        }));
        // Saved composition can't carry per-line engagementId in its
        // current jsonb shape, so we attribute each line to the
        // primary (first) engagement.
        lineEngagementIds = lines.map(() => eng.id);
      } else if (isMultiEngagement) {
        // 0086 — multi-engagement composition: one TIME_AGGREGATE line
        // per engagement, sourced from that engagement's included WIP
        // slice. Adjustments are netted onto the FIRST (primary) line
        // since adjustment_allocations are batch-scoped, not engagement
        // scoped — applying them per-engagement would require a
        // separate allocation method. Mixed-mode, surcharge, and tax
        // are skipped in v1 because they're engagement-level configs
        // that don't generalize across N engagements.
        const perEng = await deps.db
          .select({
            engagementId: timeEntries.engagementId,
            inScope: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntries.inScopeFlag} THEN ${timeEntries.standardAmountCents} ELSE 0 END), 0)`,
            overage: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntries.inScopeFlag} THEN 0 ELSE ${timeEntries.standardAmountCents} END), 0)`,
          })
          .from(billingBatchEntries)
          .innerJoin(timeEntries, eq(timeEntries.id, billingBatchEntries.timeEntryId))
          .where(
            and(
              eq(billingBatchEntries.billingBatchId, batch.id),
              eq(billingBatchEntries.action, 'INCLUDE'),
            ),
          )
          .groupBy(timeEntries.engagementId);
        const sumByEng = new Map(
          perEng.map((r) => [r.engagementId, Number(r.inScope) + Number(r.overage)]),
        );
        const built: LineItem[] = [];
        const builtEngIds: Array<string | null> = [];
        engsInOrder.forEach((e, idx) => {
          const wip = sumByEng.get(e.id) ?? 0;
          const lineAmt = idx === 0 ? wip + adjTotal : wip;
          // Skip zero-value engagements so we don't litter invoices
          // with $0 lines.
          if (lineAmt === 0) return;
          built.push({
            kind: 'TIME_AGGREGATE',
            description: `${e.name} — ${batch.periodStart} to ${batch.periodEnd}`,
            amountCents: lineAmt,
          });
          builtEngIds.push(e.id);
        });
        if (built.length === 0) {
          // All engagements had zero WIP (very unusual but possible).
          // Fall back to a single $0 line on the primary so the invoice
          // still has at least one line item.
          built.push({
            kind: 'TIME_AGGREGATE',
            description: `${eng.name} — ${batch.periodStart} to ${batch.periodEnd}`,
            amountCents: lineAmount,
          });
          builtEngIds.push(eng.id);
        }
        lines = built;
        lineEngagementIds = builtEngIds;
      } else {
        // Phase 10 #10/#11 — mixed-mode invoice composer.
        // For RECURRING_SUBSCRIPTION engagements with mixedModeEnabled=true,
        // produce two lines: the retainer (engagement.feeAmountCents as
        // RECURRING_FEE) and any out-of-scope hours rolled up as overage
        // (TIME_AGGREGATE). In-scope hours are absorbed by the retainer
        // (and already debited from the hour-bank if one exists).
        // Adjustments still net into the OOS lane since in-scope WIP is
        // not separately billed.
        const isMixedMode = eng.mixedModeEnabled && eng.feeStructure === 'RECURRING_SUBSCRIPTION';
        lines = isMixedMode
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
        lineEngagementIds = lines.map(() => eng.id);
      }
      // v2 — append per-engagement surcharge + sales tax. Order
      // matters: surcharge is computed against the pre-tax subtotal,
      // then tax is computed against (subtotal + surcharge).
      // 0086 — surcharge + tax are engagement-level configs; for
      // multi-engagement invoices we skip them (the primary engagement's
      // config wouldn't be correct for the other engagements' slices).
      const preExtrasTotals = computeTotals(lines);
      if (!isMultiEngagement && eng.surchargeEnabled) {
        // Resolve label: engagement override → firm default → 'Surcharge'.
        const [fsRow] = await deps.db
          .select({ defaultSurchargeLabel: firmSettings.defaultSurchargeLabel })
          .from(firmSettings)
          .where(eq(firmSettings.firmId, session.firmId))
          .limit(1);
        const label = eng.surchargeLabel ?? fsRow?.defaultSurchargeLabel ?? 'Surcharge';
        const line = surchargeLine({
          subtotalCents: preExtrasTotals.subtotalCents,
          type: eng.surchargeType as 'PERCENT' | 'FLAT_AMOUNT',
          valueBps: eng.surchargeValueBps,
          amountCents: Number(eng.surchargeAmountCents),
          label,
        });
        if (line) {
          lines.push(line);
          lineEngagementIds.push(eng.id);
        }
      }
      if (!isMultiEngagement && eng.taxEnabled && eng.taxRateBps > 0) {
        const surchargeSoFar = lines
          .filter((l) => l.kind === 'SURCHARGE')
          .reduce((s, l) => s + l.amountCents, 0);
        const taxBase = preExtrasTotals.subtotalCents + surchargeSoFar;
        const line = salesTaxLine({
          taxBaseCents: taxBase,
          rateBps: eng.taxRateBps,
          label: eng.taxLabel,
        });
        if (line) {
          lines.push(line);
          lineEngagementIds.push(eng.id);
        }
      }
      const totals = computeTotals(lines);

      // Captured from the offer-creation hook so we can schedule
      // reminders AFTER tx commit (BullMQ adds aren't transactional with
      // Postgres — keep them outside).
      let createdOfferId: string | null = null;
      const invoiceId = await deps.db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(invoices)
          .values({
            firmId: session.firmId,
            clientId: client.id,
            // 0086 — primary_engagement_id is NULL for consolidated
            // (multi-engagement) invoices, per the column comment in
            // packages/db/src/schema/core.ts. Single-engagement
            // invoices keep populating the convenience pointer.
            primaryEngagementId: isMultiEngagement ? null : eng.id,
            invoiceNumber,
            issueDate,
            dueDate,
            subtotalCents: totals.subtotalCents,
            feeCents: totals.processingFeeCents,
            taxCents: totals.taxCents,
            surchargeCents: totals.surchargeCents,
            totalCents: totals.totalCents,
            status: 'DRAFT',
            // 0052 — carry the batch-level invoice memo onto the invoice
            // when one was saved on the composition editor.
            notes: batch.invoiceDescription ?? null,
          })
          .returning({ id: invoices.id });
        if (!inv) throw new Error('invoice insert failed');

        await tx.insert(invoiceLineItems).values(
          lines.map((l, i) => ({
            invoiceId: inv.id,
            kind: l.kind,
            description: l.description,
            amountCents: l.amountCents,
            // 0086 — each line carries the engagement it belongs to.
            // For single-engagement invoices every line ties back to
            // `eng.id`; for multi-engagement, TIME_AGGREGATE lines tie
            // to their specific engagement (built above).
            engagementId: lineEngagementIds[i] ?? eng.id,
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

        // R2 — retainer addendum offer creation. Inside the same tx so a
        // rollback unwinds the offer too. Suppression rules in offers.ts
        // return a `reason` when no offer is created — we log and move on.
        // The biller-supplied toggle defaults to true so legacy clients
        // (no retainerOptions in body) get the feature when firm enabled.
        const toggleOn = parsed.data.retainerOptions?.enabled ?? true;
        if (toggleOn) {
          try {
            const offerResult = await maybeCreateRetainerOffer(tx as unknown as Database, {
              invoiceId: inv.id,
              engagementId: eng.id,
              firmId: session.firmId,
              clientId: client.id,
              toggleOn,
              overrides: parsed.data.retainerOptions?.overrides,
              invoiceDate: issueDate,
            });
            if (offerResult.ok) createdOfferId = offerResult.offerId;
          } catch (err) {
            logger.error({ err, invoiceId: inv.id }, 'retainer offer creation threw');
            // Surface to outer catch so the whole invoice tx rolls back.
            throw err;
          }
        }
        return inv.id;
      });

      // R4-followup — schedule offer reminder jobs now that the tx
      // committed. Best-effort; failures here don't unwind the invoice.
      if (createdOfferId) {
        try {
          const [settings] = await deps.db
            .select({
              notifyOnBill: firmRetainerSettings.notifyOnBill,
              notifyDay30: firmRetainerSettings.notifyDay30,
              notifyDay55: firmRetainerSettings.notifyDay55,
            })
            .from(firmRetainerSettings)
            .where(eq(firmRetainerSettings.firmId, session.firmId))
            .limit(1);
          if (settings) {
            const { scheduleOfferReminders } = await import('../retainers/scheduler');
            void scheduleOfferReminders({
              offerId: createdOfferId,
              notifyOnBill: settings.notifyOnBill,
              notifyDay30: settings.notifyDay30,
              notifyDay55: settings.notifyDay55,
            });
          }
        } catch (err) {
          logger.error(
            { err, offerId: createdOfferId },
            'retainer offer reminder scheduling failed',
          );
        }
      }

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
          supportFax: firmSettings.brandSupportFax,
          supportWeb: firmSettings.brandSupportWeb,
          footerHtml: firmSettings.brandFooterHtml,
          // 0053 — A/R terms text overrides footerHtml when present.
          arTermsText: firmSettings.arTermsText,
          templateStyle: firmSettings.invoiceTemplateStyle,
        })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, inv.firmId))
        .limit(1);
      // 0052 — pull structured mailing address + externalId for the
      // recipient block on the new pro PDF template.
      const [client] = await deps.db
        .select({
          name: clients.name,
          billingAddress: clients.billingAddress,
          mailingStreet1: clients.mailingStreet1,
          mailingStreet2: clients.mailingStreet2,
          mailingCity: clients.mailingCity,
          mailingState: clients.mailingState,
          mailingPostal: clients.mailingPostal,
          mailingCountry: clients.mailingCountry,
          externalId: clients.externalId,
        })
        .from(clients)
        .where(eq(clients.id, inv.clientId))
        .limit(1);
      // Reference: engagement.name when we have an engagement; else
      // fall back to invoice number.
      let engagementName: string | null = null;
      if (inv.primaryEngagementId) {
        const [eng] = await deps.db
          .select({ name: engagements.name })
          .from(engagements)
          .where(eq(engagements.id, inv.primaryEngagementId))
          .limit(1);
        engagementName = eng?.name ?? null;
      }
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
              supportFax: branding.supportFax ?? null,
              supportWeb: branding.supportWeb ?? null,
              // 0053 — A/R terms wins over generic footer when both set.
              footerHtml: branding.arTermsText
                ? branding.arTermsText
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/\n/g, '<br />')
                : (branding.footerHtml ?? null),
            }
          : null,
        reference: inv.invoiceNumber,
        engagementName,
        client: {
          name: client?.name ?? 'Client',
          billingAddress: client?.billingAddress ?? null,
          mailingStreet1: client?.mailingStreet1 ?? null,
          mailingStreet2: client?.mailingStreet2 ?? null,
          mailingCity: client?.mailingCity ?? null,
          mailingState: client?.mailingState ?? null,
          mailingPostal: client?.mailingPostal ?? null,
          mailingCountry: client?.mailingCountry ?? null,
          externalId: client?.externalId ?? null,
        },
        lines: lines.map((l) => ({
          kind: l.kind,
          description: l.description,
          amountCents: Number(l.amountCents),
        })),
        subtotalCents: Number(inv.subtotalCents),
        surchargeCents: Number(inv.surchargeCents ?? 0),
        taxCents: Number(inv.taxCents ?? 0),
        processingFeeCents: Number(inv.feeCents),
        totalCents: Number(inv.totalCents),
        notes: detailFooter ? `${inv.notes ?? ''}\n\n${detailFooter}` : (inv.notes ?? null),
      });

      // Only an explicit `?format=html` (the in-app 8.5×11 page-preview iframe)
      // gets the letter-size HTML render. A plain navigation to /pdf — e.g.
      // clicking the PDF link — must render the actual binary PDF, so we do NOT
      // key off the Accept header (browsers always send text/html, which would
      // otherwise serve HTML instead of a viewable/printable PDF).
      if (req.query['format'] === 'html') {
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

  // Send an SMS to the client's billing contact pointing at the portal
  // invoice page. Doesn't change invoice.status — SMS is a nudge, not
  // the formal "sent" signal (that stays tied to email per Q30 read
  // receipts). Returns 503 when SMS provider isn't configured, 404 if
  // the client has no billing/primary contact with a phone, 502 on
  // provider failure.
  router.post(
    '/:id/send-sms',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const sent = await sendInvoiceSms(deps, session.firmId, req.params['id']!);
      if (!sent.ok) {
        res.status(sent.status).json({ error: sent.error });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { sms: true, textedTo: sent.textedTo },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, textedTo: sent.textedTo });
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
      // QA — explicit paidCents check defends against weird states
      // where status didn't match (e.g. a payment reversed but status
      // wasn't rolled back). Also still block PARTIALLY_PAID + VOIDED.
      if (Number(inv.paidCents) > 0) {
        res
          .status(409)
          .json({ error: 'cannot_reopen_with_payments', paidCents: Number(inv.paidCents) });
        return;
      }
      if (inv.status === 'VOIDED') {
        res.status(409).json({ error: 'cannot_reopen_voided' });
        return;
      }
      // QA — only copy manual lines. SURCHARGE + SALES_TAX are auto-
      // derived; we'll regenerate them inside the transaction from
      // the engagement's *current* config (which may have changed
      // since the original invoice was generated).
      const oldLines = await deps.db
        .select()
        .from(invoiceLineItems)
        .where(
          and(
            eq(invoiceLineItems.invoiceId, inv.id),
            sql`${invoiceLineItems.kind} NOT IN ('SURCHARGE', 'SALES_TAX')`,
          ),
        );
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
            // Header cents land at 0 here; recomputeInvoiceTotals
            // below sets them from the just-copied manual lines.
            subtotalCents: 0,
            feeCents: 0,
            taxCents: 0,
            surchargeCents: 0,
            totalCents: 0,
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
        await recomputeInvoiceTotals(tx as unknown as Database, created.id);
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
    requireStepUp,
    // Void is destructive + partner-only by design (dedicated invoice:void
    // key, granted only to partner/admin) — not the broader invoice:write.
    requirePermission(deps, 'invoice:void'),
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
      const lockedReason = invoiceLockedReason(inv);
      if (lockedReason) {
        res.status(409).json({ error: 'invoice_locked', reason: lockedReason });
        return;
      }
      // QA — users add manual lines (FIXED_FEE / EXPENSE / CUSTOM /
      // TIME_AGGREGATE / MILESTONE / RECURRING_FEE / PROCESSING_FEE).
      // SURCHARGE + SALES_TAX are excluded by LineItemSchema's enum so
      // the only way to create them is the auto-derive path in
      // recomputeInvoiceTotals.
      await deps.db.transaction(async (tx) => {
        const [maxSort] = await tx
          .select({ s: sql<number>`COALESCE(MAX(${invoiceLineItems.sortOrder}), 0)` })
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, inv.id));
        await tx.insert(invoiceLineItems).values({
          invoiceId: inv.id,
          kind: parsed.data.kind,
          description: parsed.data.description,
          amountCents: parsed.data.amountCents,
          engagementId: parsed.data.engagementId ?? null,
          sourceRefType: 'manual',
          sortOrder: Number(maxSort?.s ?? 0) + 1,
        });
        await recomputeInvoiceTotals(tx as unknown as Database, inv.id);
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: inv.id,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'line_item_add',
          lineKind: parsed.data.kind,
          amountCents: parsed.data.amountCents,
        },
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
      const lockedReason = invoiceLockedReason(inv);
      if (lockedReason) {
        res.status(409).json({ error: 'invoice_locked', reason: lockedReason });
        return;
      }
      const LineItemPatchSchema = z
        .object({
          description: z.string().min(1).max(400).optional(),
          amountCents: z.number().int().optional(),
          sortOrder: z.number().int().min(0).optional(),
        })
        .refine((d) => Object.keys(d).length > 0, { message: 'no_fields' });
      const parsedPatch = LineItemPatchSchema.safeParse(req.body);
      if (!parsedPatch.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsedPatch.error.issues });
        return;
      }
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
      // Tax + surcharge lines are auto-derived and cannot be edited.
      if (orig.kind === 'SURCHARGE' || orig.kind === 'SALES_TAX') {
        res.status(400).json({ error: 'auto_derived_kind', kind: orig.kind });
        return;
      }
      await deps.db.transaction(async (tx) => {
        await tx
          .update(invoiceLineItems)
          .set(parsedPatch.data)
          .where(eq(invoiceLineItems.id, orig.id));
        await recomputeInvoiceTotals(tx as unknown as Database, inv.id);
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: inv.id,
        actorAppUserId: session.appUserId,
        before: {
          lineItemId: orig.id,
          description: orig.description,
          amountCents: Number(orig.amountCents),
        },
        after: { kind: 'line_item_edit', lineItemId: orig.id, ...parsedPatch.data },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
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
      const lockedReason = invoiceLockedReason(inv);
      if (lockedReason) {
        res.status(409).json({ error: 'invoice_locked', reason: lockedReason });
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
      if (line.kind === 'SURCHARGE' || line.kind === 'SALES_TAX') {
        res.status(400).json({ error: 'auto_derived_kind', kind: line.kind });
        return;
      }
      await deps.db.transaction(async (tx) => {
        await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.id, line.id));
        await recomputeInvoiceTotals(tx as unknown as Database, inv.id);
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: inv.id,
        actorAppUserId: session.appUserId,
        before: {
          lineItemId: line.id,
          description: line.description,
          amountCents: Number(line.amountCents),
        },
        after: { kind: 'line_item_remove' },
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

  // POST /:id/dunning sends a one-off reminder email. 0050 added a
  // 24h cooldown read from invoice_reminder_log and a row written on
  // success. Same handler is mounted at /:id/remind as an alias.
  const remindHandler = async (req: Request, res: Response): Promise<void> => {
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
    // 0050 — 24h manual cooldown. Hit invoice_reminder_log; reject if a
    // row exists within the past 24h regardless of AUTO vs MANUAL.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recent] = await deps.db
      .select({ sentAt: invoiceReminderLog.sentAt })
      .from(invoiceReminderLog)
      .where(
        and(
          eq(invoiceReminderLog.invoiceId, inv.id),
          sql`${invoiceReminderLog.sentAt} > ${cutoff.toISOString()}`,
        ),
      )
      .orderBy(desc(invoiceReminderLog.sentAt))
      .limit(1);
    if (recent) {
      res.status(429).json({ error: 'reminder_cooldown', lastSentAt: recent.sentAt });
      return;
    }
    const billingContact = await getBillingContact(deps.db, inv.clientId);
    if (!deps.sendEmail || !billingContact?.email) {
      res.status(409).json({ error: 'no_email_destination' });
      return;
    }
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
    await deps.db
      .insert(invoiceReminderLog)
      .values({
        invoiceId: inv.id,
        actorAppUserId: session.appUserId,
        kind: 'MANUAL',
        template: 'REMINDER_FRIENDLY',
        sentAt: new Date(),
      })
      .catch((err: unknown) => logger.error({ err }, 'reminder log write failed'));
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
  };

  router.post('/:id/dunning', requirePermission(deps, 'invoice:write'), remindHandler);
  router.post('/:id/remind', requirePermission(deps, 'invoice:write'), remindHandler);

  router.post(
    '/:id/refund',
    requireStepUp,
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

async function sendInvoiceSms(
  deps: InvoiceRoutesDeps,
  firmId: string,
  invoiceId: string,
): Promise<{ ok: true; textedTo: string | null } | { ok: false; status: number; error: string }> {
  if (!deps.db) return { ok: false, status: 503, error: 'db_unavailable' };
  if (!deps.sendSms) return { ok: false, status: 503, error: 'sms_provider_not_configured' };
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
  if (!billingContact?.phone) {
    return { ok: false, status: 404, error: 'no_billing_phone' };
  }
  const portalBase = deps.portalBaseUrl ?? '';
  const link = portalBase ? `${portalBase}/invoices/${inv.id}` : '';
  const total = (Number(inv.totalCents) / 100).toFixed(2);
  // Keep the body short — SMS limits + many providers truncate around
  // 160 chars per segment. ~140 leaves room for a short link rewrite.
  const body =
    `${client.name}: invoice ${inv.invoiceNumber} for $${total} is ready (due ${inv.dueDate}).` +
    (link ? ` View: ${link}` : '');
  try {
    await deps.sendSms({ to: billingContact.phone, body });
    await recordOutbound({
      db: deps.db,
      firmId,
      clientId: inv.clientId,
      channel: 'SMS',
      body,
      relatedEntityType: 'invoice',
      relatedEntityId: inv.id,
    }).catch((err) => logger.warn({ err }, 'comms record failed'));
  } catch (err) {
    logger.error({ err, invoiceId: inv.id }, 'invoice sms dispatch failed');
    return { ok: false, status: 502, error: 'sms_dispatch_failed' };
  }
  return { ok: true, textedTo: billingContact.phone };
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
