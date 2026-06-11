// SPDX-License-Identifier: Elastic-2.0
//
// Portal-side invoice endpoints. Scoped to the session's active_client_id.
// Marks invoice.first_viewed_at on first GET (Q30 — portal-view receipt).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clients,
  firmSettings,
  firms,
  invoiceLineItems,
  invoices,
  payments,
} from '@vibe/db/schema';
import { renderInvoiceHtml } from '@vibe/core/invoicing';

import { emitAudit } from '../auth/audit';
import { renderReceiptHtml } from '../invoices/receipt-exports';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { resolveScope } from './scope';

export interface PortalInvoiceRoutesDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  // Pluggable payment provider, wired from app.ts.
  chargeInvoice?: (args: {
    invoiceId: string;
    amountCents: number;
    metadata: Record<string, string>;
  }) => Promise<{ ok: boolean; providerChargeId?: string; errorMessage?: string }>;
}

const PaySchema = z.object({
  paymentMethodToken: z.string().min(1).optional(),
  amountCents: z.number().int().positive().optional(),
});

export function createPortalInvoiceRouter(deps: PortalInvoiceRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ open: [], paid: [] });
      return;
    }
    const scope = await resolveScope(deps.db, session, req);
    const rows = await deps.db
      .select({
        id: invoices.id,
        clientId: invoices.clientId,
        invoiceNumber: invoices.invoiceNumber,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        totalCents: invoices.totalCents,
        paidCents: invoices.paidCents,
        status: invoices.status,
      })
      .from(invoices)
      .where(
        and(
          inArray(invoices.clientId, scope.clientIds),
          inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE']),
        ),
      )
      .orderBy(desc(invoices.issueDate))
      .limit(500);
    const open = rows.filter((r) => r.status !== 'PAID');
    const paid = rows.filter((r) => r.status === 'PAID');
    res.json({ open, paid, scope: scope.isConsolidated ? 'all_accessible' : 'active' });
  });

  router.get('/:id', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ invoice: null });
      return;
    }
    const [inv] = await deps.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, req.params['id']!), eq(invoices.clientId, session.activeClientId)))
      .limit(1);
    // Drafts are not finalized and must never be visible to a client, even by
    // direct URL — treat them as not found.
    if (!inv || inv.status === 'DRAFT') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const lines = await deps.db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, inv.id))
      .orderBy(invoiceLineItems.sortOrder);

    // CP3 — payment history for the receipt-download button. Privacy-
    // safe shape: id + amount + provider + when. Drops payment-method
    // ids, fee internals, retry counters.
    const paymentRows = await deps.db
      .select({
        id: payments.id,
        amountCents: payments.amountCents,
        provider: payments.provider,
        status: payments.status,
        receivedAt: payments.receivedAt,
        refundedAt: payments.refundedAt,
        refundedAmountCents: payments.refundedAmountCents,
      })
      .from(payments)
      .where(eq(payments.invoiceId, inv.id))
      .orderBy(desc(payments.receivedAt));

    // Q30: portal-view receipt
    if (!inv.firstViewedAt) {
      await deps.db
        .update(invoices)
        .set({ firstViewedAt: new Date() })
        .where(and(eq(invoices.id, inv.id), isNull(invoices.firstViewedAt)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'invoice',
        entityId: inv.id,
        actorPortalIdentityId: session.portalIdentityId,
        activeClientId: session.activeClientId,
        after: { firstViewedAt: 'now' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    }
    res.json({ invoice: inv, lineItems: lines, payments: paymentRows });
  });

  // Build the letter-size invoice HTML for a client-scoped invoice. Shared by
  // the HTML page preview and the binary PDF download below. Returns null when
  // the invoice doesn't exist for this client (or the DB is unavailable).
  async function assembleInvoiceHtml(
    id: string,
    clientId: string,
  ): Promise<{ html: string; invoiceNumber: string } | null> {
    if (!deps.db) return null;
    const [inv] = await deps.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.clientId, clientId)))
      .limit(1);
    // Never render a draft for a client (page preview or PDF), even by URL.
    if (!inv || inv.status === 'DRAFT') return null;
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
        arTermsText: firmSettings.arTermsText,
        templateStyle: firmSettings.invoiceTemplateStyle,
      })
      .from(firmSettings)
      .where(eq(firmSettings.firmId, inv.firmId))
      .limit(1);
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
    const lines = await deps.db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, inv.id))
      .orderBy(invoiceLineItems.sortOrder);
    const style: 'modern' | 'classic' | 'minimal' =
      branding?.templateStyle === 'classic' || branding?.templateStyle === 'minimal'
        ? branding.templateStyle
        : 'modern';
    const html = renderInvoiceHtml({
      invoiceNumber: inv.invoiceNumber,
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      style,
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
      processingFeeCents: Number(inv.feeCents),
      totalCents: Number(inv.totalCents),
      notes: inv.notes ?? null,
    });
    return { html, invoiceNumber: inv.invoiceNumber };
  }

  // HTML page preview (used by the in-app 8.5×11 page view iframe).
  router.get('/:id/pdf.html', deps.requireAuth, async (req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).send('db_unavailable');
      return;
    }
    const built = await assembleInvoiceHtml(req.params['id']!, req.portalSession!.activeClientId);
    if (!built) {
      res.status(404).send('not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(built.html);
  });

  // Proper binary PDF download of the invoice. Falls back to serving the HTML
  // if the renderer is unavailable (same behavior as the staff endpoint).
  router.get('/:id/pdf', deps.requireAuth, async (req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const built = await assembleInvoiceHtml(req.params['id']!, req.portalSession!.activeClientId);
    if (!built) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    try {
      const { renderHtmlToPdf } = await import('../pdf/render');
      const pdf = await renderHtmlToPdf(built.html);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${built.invoiceNumber}.pdf"`);
      res.send(pdf);
    } catch (err) {
      logger.error({ err }, 'invoice pdf render failed');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(built.html);
    }
  });

  router.get(
    '/:id/payments/:paymentId/receipt',
    deps.requireAuth,
    async (req: Request, res: Response) => {
      const session = req.portalSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [inv] = await deps.db
        .select()
        .from(invoices)
        .where(
          and(eq(invoices.id, req.params['id']!), eq(invoices.clientId, session.activeClientId)),
        )
        .limit(1);
      if (!inv) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [pay] = await deps.db
        .select()
        .from(payments)
        .where(and(eq(payments.id, req.params['paymentId']!), eq(payments.invoiceId, inv.id)))
        .limit(1);
      if (!pay) {
        res.status(404).json({ error: 'payment_not_found' });
        return;
      }
      const [firm] = await deps.db
        .select({ name: firms.name })
        .from(firms)
        .where(eq(firms.id, inv.firmId))
        .limit(1);
      const [client] = await deps.db
        .select({ name: clients.name })
        .from(clients)
        .where(eq(clients.id, inv.clientId))
        .limit(1);
      const html = renderReceiptHtml({
        firmName: firm?.name ?? 'Firm',
        clientName: client?.name ?? 'Client',
        invoiceNumber: inv.invoiceNumber,
        paymentId: pay.id,
        amountCents: Number(pay.amountCents),
        receivedAt: pay.receivedAt,
        providerChargeId: pay.providerChargeId,
        refundedAt: pay.refundedAt,
        refundedAmountCents:
          pay.refundedAmountCents != null ? Number(pay.refundedAmountCents) : null,
      });
      const accept = req.header('accept') ?? '';
      if (accept.includes('text/html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
        return;
      }
      try {
        const { renderHtmlToPdf } = await import('../pdf/render');
        const pdf = await renderHtmlToPdf(html);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `inline; filename="receipt-${inv.invoiceNumber}-${pay.id.slice(0, 8)}.pdf"`,
        );
        res.send(pdf);
      } catch (err) {
        logger.error({ err }, 'receipt pdf render failed');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      }
    },
  );

  router.post('/:id/pay', deps.requireAuth, async (req: Request, res: Response) => {
    const parsed = PaySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [inv] = await deps.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, req.params['id']!), eq(invoices.clientId, session.activeClientId)))
      .limit(1);
    if (!inv) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (inv.status === 'DRAFT' || inv.status === 'PAID' || inv.status === 'VOIDED') {
      res.status(409).json({ error: 'invoice_not_payable', status: inv.status });
      return;
    }

    const amount = parsed.data.amountCents ?? inv.totalCents - inv.paidCents;
    if (amount <= 0) {
      res.status(400).json({ error: 'no_balance_due' });
      return;
    }

    const result = deps.chargeInvoice
      ? await deps.chargeInvoice({
          invoiceId: inv.id,
          amountCents: amount,
          metadata: {
            invoice_id: inv.id,
            invoice_number: inv.invoiceNumber,
            firm_id: inv.firmId,
            client_id: inv.clientId,
          },
        })
      : { ok: false, errorMessage: 'no_payment_provider_configured' };

    if (!result.ok) {
      res.status(402).json({ error: 'payment_failed', detail: result.errorMessage });
      return;
    }

    await deps.db.transaction(async (tx) => {
      await tx.insert(payments).values({
        invoiceId: inv.id,
        amountCents: amount,
        feeCents: 0,
        provider: 'STRIPE',
        providerChargeId: result.providerChargeId ?? null,
        status: 'SUCCEEDED',
        receivedAt: new Date(),
      });
      const newPaid = inv.paidCents + amount;
      const newStatus = newPaid >= inv.totalCents ? 'PAID' : 'PARTIALLY_PAID';
      await tx
        .update(invoices)
        .set({
          paidCents: newPaid,
          status: newStatus,
          paidAt: newStatus === 'PAID' ? new Date() : null,
        })
        .where(eq(invoices.id, inv.id));
    });

    await emitAudit(deps.db, {
      action: 'PAYMENT',
      entityType: 'invoice',
      entityId: inv.id,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: { amountCents: amount, providerChargeId: result.providerChargeId },
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.json({ ok: true, paidCents: inv.paidCents + amount });
  });

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
