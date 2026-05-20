// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// AR aging endpoints (Phase 15). Bucketizes outstanding invoices by days
// past their due date, scoped to the firm. Uses the @vibe/core/billing
// bucketize helper so staff and any future report consumers share semantics.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, invoices } from '@vibe/db/schema';
import { sql as drizzleSql } from 'drizzle-orm';
import { bucketize, type AgingBucket } from '@vibe/core/billing';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface ArRoutesDeps extends RbacDeps {
  db: Database | null;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  portalBaseUrl?: string;
}

interface ClientAging {
  clientId: string;
  clientName: string;
  buckets: Record<AgingBucket, number>;
  total: number;
  partnerId?: string;
}

export function createArRouter(deps: ArRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/aging',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({
          asOf: new Date().toISOString().slice(0, 10),
          totals: emptyBuckets(),
          clients: [],
        });
        return;
      }
      const data = await loadAging(deps.db, session.firmId, {
        partnerId: typeof req.query['partnerId'] === 'string' ? req.query['partnerId'] : undefined,
      });
      if (String(req.query['format'] ?? '').toLowerCase() === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="ar-aging-${data.asOf}.csv"`);
        res.send(agingToCsv(data));
        return;
      }
      res.json(data);
    },
  );

  router.get(
    '/by-engagement/:engagementId',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const open = await deps.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          dueDate: invoices.dueDate,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
          status: invoices.status,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            eq(invoices.primaryEngagementId, req.params['engagementId']!),
            inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
          ),
        )
        .orderBy(desc(invoices.dueDate));
      const today = new Date().toISOString().slice(0, 10);
      const aging = bucketize(
        open
          .map((o) => ({
            entryDate: o.dueDate,
            amountCents: Number(o.totalCents) - Number(o.paidCents),
          }))
          .filter((r) => r.amountCents > 0),
        today,
      );
      res.json({ items: open, aging });
    },
  );

  router.get(
    '/top-clients',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const limit = Math.min(
        Math.max(parseInt(String(req.query['limit'] ?? '10'), 10) || 10, 1),
        100,
      );
      const data = await loadAging(deps.db, session.firmId);
      res.json({ items: data.clients.slice(0, limit) });
    },
  );

  router.get(
    '/snapshots',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const days = Math.min(
        Math.max(parseInt(String(req.query['days'] ?? '30'), 10) || 30, 1),
        365,
      );
      const rows = await deps.db.execute(drizzleSql`
        SELECT
          as_of_date::text                            AS "asOfDate",
          SUM(bucket_0_30_cents)::bigint              AS "b0to30",
          SUM(bucket_31_60_cents)::bigint             AS "b31to60",
          SUM(bucket_61_90_cents)::bigint             AS "b61to90",
          SUM(bucket_90_plus_cents)::bigint           AS "b90plus",
          SUM(total_cents)::bigint                    AS "total"
        FROM ar_aging_snapshot
        WHERE firm_id = ${session.firmId}
          AND as_of_date >= CURRENT_DATE - ${days}::int
        GROUP BY as_of_date
        ORDER BY as_of_date DESC
      `);
      res.json({
        items: (rows as unknown as { rows: unknown[] }).rows ?? rows,
      });
    },
  );

  router.get(
    '/statement/:clientId',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ statement: null });
        return;
      }
      const [client] = await deps.db
        .select()
        .from(clients)
        .where(and(eq(clients.id, req.params['clientId']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const open = await deps.db
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
            eq(invoices.firmId, session.firmId),
            eq(invoices.clientId, client.id),
            inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
          ),
        );
      const today = new Date().toISOString().slice(0, 10);
      const aging = bucketize(
        open
          .map((o) => ({
            entryDate: o.dueDate,
            amountCents: Number(o.totalCents) - Number(o.paidCents),
          }))
          .filter((r) => r.amountCents > 0),
        today,
      );
      const balance = Object.values(aging).reduce((s, n) => s + n, 0);
      res.json({
        statement: {
          asOfDate: today,
          client: { id: client.id, name: client.name },
          balanceCents: balance,
          aging,
          openInvoices: open,
        },
      });
    },
  );

  router.post(
    '/statement/:clientId/send',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [client] = await deps.db
        .select()
        .from(clients)
        .where(and(eq(clients.id, req.params['clientId']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      if (!deps.sendEmail || !client.billingContactEmail) {
        res.status(409).json({ error: 'no_email_destination' });
        return;
      }
      const open = await deps.db
        .select({
          invoiceNumber: invoices.invoiceNumber,
          dueDate: invoices.dueDate,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            eq(invoices.clientId, client.id),
            inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
          ),
        );
      const today = new Date().toISOString().slice(0, 10);
      const rows = open
        .map((o) => ({
          line: `${o.invoiceNumber}  due ${o.dueDate}  balance $${(
            (Number(o.totalCents) - Number(o.paidCents)) /
            100
          ).toFixed(2)}`,
          amountCents: Number(o.totalCents) - Number(o.paidCents),
        }))
        .filter((r) => r.amountCents > 0);
      const balance = rows.reduce((s, r) => s + r.amountCents, 0);
      const body =
        `Account statement for ${client.name} as of ${today}:\n\n` +
        rows.map((r) => r.line).join('\n') +
        `\n\nTotal balance: $${(balance / 100).toFixed(2)}`;
      try {
        await deps.sendEmail({
          to: client.billingContactEmail,
          subject: `Statement of account — ${client.name}`,
          body,
        });
      } catch (err) {
        res.status(502).json({ error: 'email_dispatch_failed' });
        return;
      }
      res.json({ ok: true, sentTo: client.billingContactEmail, balanceCents: balance });
    },
  );

  return router;
}

async function loadAging(
  db: Database,
  firmId: string,
  opts: { partnerId?: string } = {},
): Promise<{ asOf: string; totals: Record<AgingBucket, number>; clients: ClientAging[] }> {
  const today = new Date().toISOString().slice(0, 10);
  const conds = [
    eq(invoices.firmId, firmId),
    inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
    ne(invoices.status, 'VOIDED'),
  ];
  if (opts.partnerId) {
    conds.push(eq(clients.partnerInChargeId, opts.partnerId));
  }
  const outstanding = await db
    .select({
      id: invoices.id,
      dueDate: invoices.dueDate,
      totalCents: invoices.totalCents,
      paidCents: invoices.paidCents,
      clientId: invoices.clientId,
      clientName: clients.name,
      partnerId: clients.partnerInChargeId,
    })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .where(and(...conds))
    .orderBy(desc(invoices.dueDate));

  const byClient = new Map<
    string,
    {
      name: string;
      partnerId: string;
      rows: { entryDate: string; amountCents: number }[];
    }
  >();
  for (const inv of outstanding) {
    const balance = Number(inv.totalCents) - Number(inv.paidCents);
    if (balance <= 0) continue;
    const arr = byClient.get(inv.clientId) ?? {
      name: inv.clientName,
      partnerId: inv.partnerId,
      rows: [],
    };
    arr.rows.push({ entryDate: inv.dueDate, amountCents: balance });
    byClient.set(inv.clientId, arr);
  }
  const clientsOut: ClientAging[] = [];
  const totals = emptyBuckets();
  for (const [clientId, v] of byClient) {
    const b = bucketize(v.rows, today);
    const total = b['0-30'] + b['31-60'] + b['61-90'] + b['90+'];
    clientsOut.push({
      clientId,
      clientName: v.name,
      buckets: b,
      total,
      partnerId: v.partnerId,
    });
    totals['0-30'] += b['0-30'];
    totals['31-60'] += b['31-60'];
    totals['61-90'] += b['61-90'];
    totals['90+'] += b['90+'];
  }
  clientsOut.sort((a, b) => b.total - a.total);
  return { asOf: today, totals, clients: clientsOut };
}

function agingToCsv(data: {
  asOf: string;
  clients: ClientAging[];
  totals: Record<AgingBucket, number>;
}): string {
  const header = ['Client', 'PartnerId', '0-30', '31-60', '61-90', '90+', 'Total'];
  const lines = [header.join(',')];
  for (const c of data.clients) {
    lines.push(
      [
        csvCell(c.clientName),
        c.partnerId ?? '',
        c.buckets['0-30'],
        c.buckets['31-60'],
        c.buckets['61-90'],
        c.buckets['90+'],
        c.total,
      ].join(','),
    );
  }
  lines.push(
    [
      'TOTAL',
      '',
      data.totals['0-30'],
      data.totals['31-60'],
      data.totals['61-90'],
      data.totals['90+'],
      data.totals['0-30'] + data.totals['31-60'] + data.totals['61-90'] + data.totals['90+'],
    ].join(','),
  );
  return lines.join('\n') + '\n';
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function emptyBuckets(): Record<AgingBucket, number> {
  return { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
}
