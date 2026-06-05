// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0054 — Statement of Account routes.
//
// Per-client (single) and selected-clients (bulk) statements. Single
// returns HTML / PDF based on Accept header. Bulk returns one combined
// PDF with page-breaks between statements, so the operator can print
// the entire month's statements in one shot. Email variants ship the
// PDF as an attachment to the client's billing contact.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, inArray, ne } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clientContacts,
  clients,
  firmSettings,
  firms,
  invoices,
  payments,
  persons,
} from '@vibe/db/schema';
import {
  combineStatementsHtml,
  renderStatementHtml,
  type StatementLine,
  type StatementTemplateInput,
} from '@vibe/core/invoicing';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { renderHtmlToPdf } from '../pdf/render';
import { logger } from '../logger';

export interface StatementsRoutesDeps extends RbacDeps {
  db: Database | null;
  sendStaffMail?: (args: {
    to: string;
    subject: string;
    body: string;
    html?: string;
    attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
  }) => Promise<void>;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${a}T00:00:00`) - Date.parse(`${b}T00:00:00`)) / (1000 * 60 * 60 * 24),
  );
}

/** Build the statement-template input for one client. Pulls SENT /
 *  PARTIALLY_PAID / OVERDUE invoices and their payments, computes a
 *  running balance per row, and bucketizes outstanding amounts by
 *  days-past-due. */
async function buildStatement(
  db: Database,
  firmId: string,
  clientId: string,
  asOfIso: string,
  branding: {
    displayName?: string | null;
    logoUrl?: string | null;
    accentColor?: string | null;
    supportEmail?: string | null;
    supportPhone?: string | null;
    supportFax?: string | null;
    supportWeb?: string | null;
    arTermsText?: string | null;
    footerHtml?: string | null;
  } | null,
  firmRow: { name: string } | null,
): Promise<StatementTemplateInput | null> {
  const [clientRow] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  if (!clientRow) return null;

  const invs = await db
    .select({
      id: invoices.id,
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
        eq(invoices.firmId, firmId),
        eq(invoices.clientId, clientId),
        inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
        ne(invoices.status, 'VOIDED'),
      ),
    )
    .orderBy(invoices.issueDate);

  const lines: StatementLine[] = [];
  let running = 0;
  let bucket0 = 0;
  let bucket30 = 0;
  let bucket60 = 0;
  let bucket90 = 0;
  let bucket121 = 0;

  for (const inv of invs) {
    const total = Number(inv.totalCents);
    const paid = Number(inv.paidCents);
    const balance = total - paid;
    if (balance <= 0) continue;

    running += total;
    lines.push({
      date: inv.issueDate,
      type: 'Invoice',
      reference: inv.invoiceNumber,
      debitCents: total,
      balanceCents: running,
    });

    if (paid > 0) {
      // Show payments as a credit immediately after the invoice row.
      const pays = await db
        .select({
          id: payments.id,
          amountCents: payments.amountCents,
          receivedAt: payments.receivedAt,
        })
        .from(payments)
        .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, 'SUCCEEDED')));
      for (const p of pays) {
        const credit = Number(p.amountCents);
        running -= credit;
        const dateIso = p.receivedAt
          ? new Date(p.receivedAt).toISOString().slice(0, 10)
          : inv.issueDate;
        lines.push({
          date: dateIso,
          type: 'Payment',
          reference: p.id.slice(0, 8),
          creditCents: credit,
          balanceCents: running,
        });
      }
    }

    // Bucket the remaining balance by days past due (or issue date if
    // due is null). Compare against asOf, not today, so historic
    // statements stay stable.
    const ageRef = inv.dueDate || inv.issueDate;
    const daysPastDue = daysBetween(asOfIso, ageRef);
    if (daysPastDue <= 30) bucket0 += balance;
    else if (daysPastDue <= 60) bucket30 += balance;
    else if (daysPastDue <= 90) bucket60 += balance;
    else if (daysPastDue <= 120) bucket90 += balance;
    else bucket121 += balance;
  }

  const totalDue = bucket0 + bucket30 + bucket60 + bucket90 + bucket121;

  return {
    statementDate: asOfIso,
    firm: {
      name: branding?.displayName || firmRow?.name || 'Firm',
      logoUrl: branding?.logoUrl ?? null,
      address: null,
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
    client: {
      name: clientRow.name,
      externalId: clientRow.externalId ?? null,
      mailingStreet1: clientRow.mailingStreet1 ?? null,
      mailingStreet2: clientRow.mailingStreet2 ?? null,
      mailingCity: clientRow.mailingCity ?? null,
      mailingState: clientRow.mailingState ?? null,
      mailingPostal: clientRow.mailingPostal ?? null,
      mailingCountry: clientRow.mailingCountry ?? null,
      billingAddress: clientRow.billingAddress ?? null,
    },
    lines,
    totalAmountDueCents: totalDue,
    aging: {
      d_0_30: bucket0,
      d_31_60: bucket30,
      d_61_90: bucket60,
      d_91_120: bucket90,
      d_121_plus: bucket121,
    },
    policyNotice:
      'Accounts with balances over 90 days past due will have all work suspended until payment is received.',
  };
}

async function loadBranding(
  db: Database,
  firmId: string,
): Promise<{
  displayName?: string | null;
  logoUrl?: string | null;
  accentColor?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  supportFax?: string | null;
  supportWeb?: string | null;
  arTermsText?: string | null;
  footerHtml?: string | null;
}> {
  const [b] = await db
    .select({
      displayName: firmSettings.brandDisplayName,
      logoUrl: firmSettings.brandLogoUrl,
      accentColor: firmSettings.brandAccentColor,
      supportEmail: firmSettings.brandSupportEmail,
      supportPhone: firmSettings.brandSupportPhone,
      supportFax: firmSettings.brandSupportFax,
      supportWeb: firmSettings.brandSupportWeb,
      arTermsText: firmSettings.arTermsText,
      footerHtml: firmSettings.brandFooterHtml,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  return b ?? {};
}

export function createStatementsRouter(deps: StatementsRoutesDeps): Router {
  const router = express.Router();
  // A non-UUID :clientId would otherwise reach Postgres as a 22P02 cast
  // error (500); reject it up front as a clean 404.
  addUuidIdGuard(router, ['clientId']);

  // GET /api/staff/statements/clients/:clientId — single client statement.
  // ?accept=pdf or Accept: application/pdf → PDF, else HTML.
  router.get(
    '/clients/:clientId',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [firmRow] = await deps.db
        .select({ name: firms.name })
        .from(firms)
        .where(eq(firms.id, session.firmId))
        .limit(1);
      const branding = await loadBranding(deps.db, session.firmId);
      const asOf = new Date().toISOString().slice(0, 10);
      const input = await buildStatement(
        deps.db,
        session.firmId,
        req.params['clientId']!,
        asOf,
        branding,
        firmRow ?? null,
      );
      if (!input) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const html = renderStatementHtml(input);
      const wantsPdf =
        (req.query['accept'] as string | undefined) === 'pdf' ||
        (req.header('accept') ?? '').includes('application/pdf');
      if (wantsPdf) {
        try {
          const pdf = await renderHtmlToPdf(html);
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="statement-${input.client.name.replace(/[^a-z0-9-]+/gi, '_')}-${asOf}.pdf"`,
          );
          res.send(pdf);
          return;
        } catch (err) {
          logger.error({ err }, 'statement pdf render failed');
          res.status(500).json({ error: 'pdf_render_failed' });
          return;
        }
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    },
  );

  // POST /api/staff/statements/bulk-generate — body { clientIds: [...] }.
  // Returns one combined PDF with all selected client statements, one
  // per page-break-separated section.
  router.post(
    '/bulk-generate',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const body = req.body as { clientIds?: unknown };
      // Only accept well-formed UUID strings; anything else is dropped
      // (an empty string slipped through earlier and broke the SQL).
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const ids = Array.isArray(body.clientIds)
        ? body.clientIds.filter((x): x is string => typeof x === 'string' && uuidRe.test(x))
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: 'no_client_ids' });
        return;
      }
      if (ids.length > 200) {
        res.status(400).json({ error: 'too_many', max: 200 });
        return;
      }
      const [firmRow] = await deps.db
        .select({ name: firms.name })
        .from(firms)
        .where(eq(firms.id, session.firmId))
        .limit(1);
      const branding = await loadBranding(deps.db, session.firmId);
      const asOf = new Date().toISOString().slice(0, 10);

      const htmls: string[] = [];
      const generated: string[] = [];
      const skipped: string[] = [];
      for (const cid of ids) {
        const input = await buildStatement(
          deps.db,
          session.firmId,
          cid,
          asOf,
          branding,
          firmRow ?? null,
        );
        if (!input) {
          skipped.push(cid);
          continue;
        }
        if (input.lines.length === 0) {
          // Skip clients with no outstanding invoices.
          skipped.push(cid);
          continue;
        }
        htmls.push(renderStatementHtml(input));
        generated.push(cid);
      }
      if (htmls.length === 0) {
        res.status(404).json({ error: 'no_statements_generated', skipped });
        return;
      }
      const combined = combineStatementsHtml(htmls);
      try {
        const pdf = await renderHtmlToPdf(combined);
        await emitAudit(deps.db, {
          action: 'EXPORT',
          entityType: 'statement_bulk',
          actorAppUserId: session.appUserId,
          after: { generatedFor: generated, skipped, asOf },
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="statements-${asOf}.pdf"`);
        res.setHeader('X-Generated-Count', String(generated.length));
        res.setHeader('X-Skipped-Count', String(skipped.length));
        res.send(pdf);
      } catch (err) {
        logger.error({ err }, 'bulk statement pdf render failed');
        res.status(500).json({ error: 'pdf_render_failed' });
      }
    },
  );

  // POST /api/staff/statements/bulk-email — same input, but mails one
  // statement-as-attachment to each client's billing contact.
  router.post(
    '/bulk-email',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db || !deps.sendStaffMail) {
        res.status(503).json({ error: 'email_not_wired' });
        return;
      }
      const body = req.body as { clientIds?: unknown };
      // Only accept well-formed UUID strings; anything else is dropped
      // (an empty string slipped through earlier and broke the SQL).
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const ids = Array.isArray(body.clientIds)
        ? body.clientIds.filter((x): x is string => typeof x === 'string' && uuidRe.test(x))
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: 'no_client_ids' });
        return;
      }
      if (ids.length > 200) {
        res.status(400).json({ error: 'too_many', max: 200 });
        return;
      }
      const [firmRow] = await deps.db
        .select({ name: firms.name })
        .from(firms)
        .where(eq(firms.id, session.firmId))
        .limit(1);
      const branding = await loadBranding(deps.db, session.firmId);
      const asOf = new Date().toISOString().slice(0, 10);

      const sent: Array<{ clientId: string; to: string }> = [];
      const skipped: Array<{ clientId: string; reason: string }> = [];

      for (const cid of ids) {
        const input = await buildStatement(
          deps.db,
          session.firmId,
          cid,
          asOf,
          branding,
          firmRow ?? null,
        );
        if (!input) {
          skipped.push({ clientId: cid, reason: 'not_found' });
          continue;
        }
        if (input.lines.length === 0) {
          skipped.push({ clientId: cid, reason: 'no_outstanding' });
          continue;
        }
        const [billing] = await deps.db
          .select({ email: persons.email })
          .from(clientContacts)
          .innerJoin(persons, eq(persons.id, clientContacts.personId))
          .where(and(eq(clientContacts.clientId, cid), eq(clientContacts.isBilling, true)))
          .limit(1);
        if (!billing?.email) {
          skipped.push({ clientId: cid, reason: 'no_billing_email' });
          continue;
        }
        try {
          const html = renderStatementHtml(input);
          const pdf = await renderHtmlToPdf(html);
          const fileSafeName = input.client.name.replace(/[^a-z0-9-]+/gi, '_');
          await deps.sendStaffMail({
            to: billing.email,
            subject: `Statement of Account — ${input.client.name} — ${asOf}`,
            body: `Hello,\n\nPlease find attached your statement of account as of ${asOf}.\nTotal amount due: $${(input.totalAmountDueCents / 100).toFixed(2)}.\n\nReply to this message with any questions.`,
            attachments: [
              {
                filename: `statement-${fileSafeName}-${asOf}.pdf`,
                content: pdf,
                contentType: 'application/pdf',
              },
            ],
          });
          sent.push({ clientId: cid, to: billing.email });
        } catch (err) {
          logger.error({ err, clientId: cid }, 'statement email failed');
          skipped.push({
            clientId: cid,
            reason: err instanceof Error ? err.message : 'send_failed',
          });
        }
      }

      await emitAudit(deps.db, {
        action: 'EXPORT',
        entityType: 'statement_bulk_email',
        actorAppUserId: session.appUserId,
        after: { sentCount: sent.length, skippedCount: skipped.length, asOf, sent, skipped },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.json({ ok: true, sent, skipped });
    },
  );

  return router;
}
