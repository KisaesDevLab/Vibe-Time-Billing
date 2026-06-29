// SPDX-License-Identifier: Elastic-2.0
//
// 0054 — Statement of Account routes.
//
// Per-client (single) and selected-clients (bulk) statements. Single
// returns HTML / PDF based on Accept header. Bulk returns one combined
// PDF with page-breaks between statements, so the operator can print
// the entire month's statements in one shot. Email variants ship the
// PDF as an attachment to the client's billing contact.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientContacts, firms, persons } from '@vibe/db/schema';
import {
  combineStatementsHtml,
  formatMoneyCents,
  renderStatementDocument,
} from '@vibe/core/invoicing';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { firmScope, renderTemplate } from '../notifications/templating';
import { printNotificationChannel } from '../notifications/print-channel';
import { renderHtmlToPdf } from '../pdf/render';
import { logger } from '../logger';

import { buildStatement, loadBranding } from './build';
import { loadStatementTemplateDef } from './template-loader';

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
      // ?mode=activity&start=YYYY-MM-DD&end=YYYY-MM-DD → account-activity
      // statement with opening/closing balance; default is outstanding.
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      const qMode = req.query['mode'] === 'activity' ? 'activity' : 'outstanding';
      const qStart =
        typeof req.query['start'] === 'string' && dateRe.test(req.query['start'])
          ? req.query['start']
          : undefined;
      const qEnd =
        typeof req.query['end'] === 'string' && dateRe.test(req.query['end'])
          ? req.query['end']
          : undefined;
      const opts =
        qMode === 'activity' && qStart
          ? { mode: 'activity' as const, start: qStart, end: qEnd ?? asOf }
          : {};
      const input = await buildStatement(
        deps.db,
        session.firmId,
        req.params['clientId']!,
        asOf,
        branding,
        firmRow ?? null,
        opts,
      );
      if (!input) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const templateDef = await loadStatementTemplateDef(deps.db, session.firmId);
      const html = renderStatementDocument(input, templateDef);
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
      const templateDef = await loadStatementTemplateDef(deps.db, session.firmId);
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
        htmls.push(renderStatementDocument(input, templateDef));
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
      const templateDef = await loadStatementTemplateDef(deps.db, session.firmId);
      const asOf = new Date().toISOString().slice(0, 10);
      const firm = await firmScope(deps.db, session.firmId);

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
          const html = renderStatementDocument(input, templateDef);
          const pdf = await renderHtmlToPdf(html);
          const fileSafeName = input.client.name.replace(/[^a-z0-9-]+/gi, '_');
          const balanceStr = formatMoneyCents(input.totalAmountDueCents);
          const rendered = await renderTemplate({
            db: deps.db,
            firmId: session.firmId,
            kind: 'statement_sent',
            channel: 'EMAIL',
            fallback: {
              subject: `Statement of Account — ${input.client.name} — ${asOf}`,
              body: `Hello,\n\nPlease find attached your statement of account as of ${asOf}.\nTotal amount due: ${balanceStr}.\n\nReply to this message with any questions.`,
            },
            context: {
              client: { name: input.client.name },
              firm,
              statement: { balance: balanceStr },
            },
          });
          await deps.sendStaffMail({
            to: billing.email,
            subject: rendered.subject ?? `Statement of Account — ${input.client.name} — ${asOf}`,
            body: rendered.body,
            attachments: [
              {
                filename: `statement-${fileSafeName}-${asOf}.pdf`,
                content: pdf,
                contentType: 'application/pdf',
              },
            ],
          });
          sent.push({ clientId: cid, to: billing.email });
          await printNotificationChannel({
            db: deps.db,
            firmId: session.firmId,
            kind: 'statement_sent',
            clientId: cid,
            printableId: cid,
            context: {
              client: { name: input.client.name },
              firm,
              statement: { balance: balanceStr },
            },
          }).catch((err) => logger.warn({ err, clientId: cid }, 'statement print channel failed'));
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
