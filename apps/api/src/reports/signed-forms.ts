// SPDX-License-Identifier: Elastic-2.0
//
// Signed-forms report. A date-ranged, filterable list of completed
// (or partially-signed) e-signature requests with direct links to the
// signed PDFs + completion certificates. Backed by
// GET /api/staff/reports/signed-forms; supports ?format=csv.
//
// Date window: for status=completed we filter on completedAt (the moment
// the last signer finished); for partially_signed (which has a null
// completedAt) we fall back to sentAt so the window still bounds the set.

import express, { type Request, type Response, type Router } from 'express';
import { csvField } from '../lib/csv';
import { and, desc, eq, gte, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, signatureRequests, taxReturns } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface SignedFormRow {
  id: string;
  title: string;
  clientName: string | null;
  formType: string | null;
  signingMode: string;
  taxReturnId: string | null;
  taxReturnTitle: string | null;
  signerCount: number;
  signedCount: number;
  sentAt: string | null;
  completedAt: string | null;
  hasSigned: boolean;
  hasCertificate: boolean;
}

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return {
    from: monthStart.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
  };
}

function csvCell(s: string | number | null | undefined): string {
  return csvField(s);
}

export function createSignedFormsReportRouter(deps: { db: Database | null } & RbacDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'report:signed-forms:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;

      const range = defaultRange();
      const fromRaw =
        typeof req.query.from === 'string' && req.query.from ? req.query.from : range.from;
      const toRaw = typeof req.query.to === 'string' && req.query.to ? req.query.to : range.to;
      const from = DATE_RE.test(fromRaw) ? fromRaw : range.from;
      const to = DATE_RE.test(toRaw) ? toRaw : range.to;

      const statusRaw = typeof req.query.status === 'string' ? req.query.status : 'completed';
      const status = statusRaw === 'partially_signed' ? 'partially_signed' : 'completed';

      const format = req.query.format === 'csv' ? 'csv' : 'json';

      if (!deps.db) {
        if (format === 'csv') {
          res.setHeader('Content-Type', 'text/csv');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="signed-forms-${from}-to-${to}.csv"`,
          );
          res.send('Title,Client,Form,Mode,Tax Return,Signers,Completed\n');
          return;
        }
        res.json({ from, to, rows: [] });
        return;
      }

      // completedAt for completed requests; sentAt for partially_signed
      // (its completedAt is null until the last signer finishes).
      const dateCol =
        status === 'completed' ? signatureRequests.completedAt : signatureRequests.sentAt;

      const rows = await deps.db
        .select({
          id: signatureRequests.id,
          title: signatureRequests.title,
          clientName: clients.name,
          formType: signatureRequests.formType,
          signingMode: signatureRequests.signingMode,
          taxReturnId: signatureRequests.taxReturnId,
          taxReturnTitle: taxReturns.title,
          signerCount: signatureRequests.signerCount,
          signedCount: signatureRequests.signedCount,
          sentAt: signatureRequests.sentAt,
          completedAt: signatureRequests.completedAt,
          signedFileUrl: signatureRequests.signedFileUrl,
          certificateFileUrl: signatureRequests.certificateFileUrl,
        })
        .from(signatureRequests)
        .leftJoin(clients, eq(clients.id, signatureRequests.clientId))
        .leftJoin(taxReturns, eq(taxReturns.id, signatureRequests.taxReturnId))
        .where(
          and(
            eq(signatureRequests.firmId, session.firmId),
            eq(signatureRequests.status, status),
            gte(dateCol, new Date(`${from}T00:00:00Z`)),
            lte(dateCol, new Date(`${to}T23:59:59Z`)),
          ),
        )
        .orderBy(desc(signatureRequests.completedAt))
        .limit(1000);

      const result: SignedFormRow[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        clientName: r.clientName ?? null,
        formType: r.formType ?? null,
        signingMode: r.signingMode,
        taxReturnId: r.taxReturnId ?? null,
        taxReturnTitle: r.taxReturnTitle ?? null,
        signerCount: r.signerCount,
        signedCount: r.signedCount,
        sentAt: r.sentAt ? r.sentAt.toISOString() : null,
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        hasSigned: r.signedFileUrl != null,
        hasCertificate: r.certificateFileUrl != null,
      }));

      if (format === 'csv') {
        const lines: string[] = ['Title,Client,Form,Mode,Tax Return,Signers,Completed'];
        for (const r of result) {
          lines.push(
            [
              csvCell(r.title),
              csvCell(r.clientName),
              csvCell(r.formType ?? 'Generic'),
              csvCell(r.signingMode),
              csvCell(r.taxReturnTitle),
              csvCell(`${r.signedCount}/${r.signerCount}`),
              csvCell(r.completedAt ? r.completedAt.slice(0, 10) : ''),
            ].join(','),
          );
        }
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="signed-forms-${from}-to-${to}.csv"`,
        );
        res.send(lines.join('\n') + '\n');
        return;
      }

      res.json({ from, to, rows: result });
    },
  );

  return router;
}
