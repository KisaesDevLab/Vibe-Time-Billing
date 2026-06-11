// SPDX-License-Identifier: Elastic-2.0
//
// AR aging endpoints (Phase 15). Bucketizes outstanding invoices by days
// past their due date, scoped to the firm. Uses the @vibe/core/billing
// bucketize helper so staff and any future report consumers share semantics.

import express, { type Request, type Response, type Router } from 'express';
import { csvField } from '../lib/csv';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagementTypes, engagements, invoices, serviceLines } from '@vibe/db/schema';
import { sql as drizzleSql } from 'drizzle-orm';
import { bucketize, type AgingBucket } from '@vibe/core/billing';

import { excelTable } from '../reports/excel';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { getBillingContact } from '../clients/billing-contact';
import { recordOutbound } from '../clients/communications';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';

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
  addUuidIdGuard(router);

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
      // 0050 — accept clientOwnerId as a synonym for partnerId.
      const ownerRaw = uuidQueryParam(req.query['clientOwnerId']);
      const partnerRaw = uuidQueryParam(req.query['partnerId']);
      const clientIdFilterRaw = uuidQueryParam(req.query['clientId']);
      if (ownerRaw === 'invalid' || partnerRaw === 'invalid' || clientIdFilterRaw === 'invalid') {
        res.status(400).json({ error: 'invalid_uuid_param' });
        return;
      }
      const ownerFilter = ownerRaw ?? partnerRaw ?? undefined;
      const clientIdFilter = clientIdFilterRaw ?? undefined;
      const data = await loadAging(deps.db, session.firmId, {
        partnerId: ownerFilter,
        clientId: clientIdFilter,
      });

      // 0050 — sort + pagination on the aggregated client rows.
      const sortCol = String(req.query['sort'] ?? 'total');
      const sortDir = String(req.query['dir'] ?? 'desc') === 'asc' ? 'asc' : 'desc';
      const sign = sortDir === 'asc' ? 1 : -1;
      const sortFn = (a: ClientAging, b: ClientAging): number => {
        switch (sortCol) {
          case 'clientName':
            return sign * a.clientName.localeCompare(b.clientName);
          case 'b1':
            return sign * (a.buckets['0-30'] - b.buckets['0-30']);
          case 'b2':
            return sign * (a.buckets['31-60'] - b.buckets['31-60']);
          case 'b3':
            return sign * (a.buckets['61-90'] - b.buckets['61-90']);
          case 'b4':
            return sign * (a.buckets['90+'] - b.buckets['90+']);
          case 'total':
          default:
            return sign * (a.total - b.total);
        }
      };
      data.clients = [...data.clients].sort(sortFn);

      const paginated = req.query['page'] != null;
      const total = data.clients.length;
      if (paginated) {
        const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
        const pageSize = Math.min(
          500,
          Math.max(1, parseInt(String(req.query['pageSize'] ?? '50'), 10) || 50),
        );
        const slice = data.clients.slice((page - 1) * pageSize, page * pageSize);
        res.json({ ...data, clients: slice, rows: slice, total, page, pageSize });
        return;
      }

      const format = String(req.query['format'] ?? '').toLowerCase();
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="ar-aging-${data.asOf}.csv"`);
        res.send(agingToCsv(data));
        return;
      }
      if (format === 'xlsx' || format === 'xls' || format === 'excel') {
        const sheet = excelTable<ClientAging>({
          title: `AR aging as of ${data.asOf}`,
          columns: [
            { header: 'Client', render: (c) => c.clientName },
            { header: 'PartnerId', render: (c) => c.partnerId ?? '' },
            { header: '0-30', render: (c) => c.buckets['0-30'] / 100, numeric: true },
            { header: '31-60', render: (c) => c.buckets['31-60'] / 100, numeric: true },
            { header: '61-90', render: (c) => c.buckets['61-90'] / 100, numeric: true },
            { header: '90+', render: (c) => c.buckets['90+'] / 100, numeric: true },
            { header: 'Total', render: (c) => c.total / 100, numeric: true },
          ],
          rows: data.clients,
        });
        res.setHeader('Content-Type', sheet.mime);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="ar-aging-${data.asOf}.${sheet.ext}"`,
        );
        res.send(sheet.body);
        return;
      }
      res.json(data);
    },
  );

  router.get(
    '/delinquent',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const minDays = Math.max(parseInt(String(req.query['minDays'] ?? '60'), 10) || 60, 0);
      const cutoff = new Date(Date.now() - minDays * 86_400_000).toISOString().slice(0, 10);
      const items = await deps.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          clientId: invoices.clientId,
          clientName: clients.name,
          dueDate: invoices.dueDate,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
          status: invoices.status,
        })
        .from(invoices)
        .innerJoin(clients, eq(clients.id, invoices.clientId))
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            inArray(invoices.status, ['OVERDUE', 'PARTIALLY_PAID']),
            drizzleSql`${invoices.dueDate} <= ${cutoff}::date`,
          ),
        )
        .orderBy(invoices.dueDate);
      res.json({
        asOf: new Date().toISOString().slice(0, 10),
        minDaysOverdue: minDays,
        items: items.map((r) => ({
          ...r,
          balanceCents: Number(r.totalCents) - Number(r.paidCents),
        })),
      });
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
      const billingContact = await getBillingContact(deps.db, client.id);
      if (!deps.sendEmail || !billingContact?.email) {
        res.status(409).json({ error: 'no_email_destination' });
        return;
      }
      const billingEmail = billingContact.email;
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
      const subject = `Statement of account — ${client.name}`;
      try {
        await deps.sendEmail({ to: billingEmail, subject, body });
        await recordOutbound({
          db: deps.db,
          firmId: session.firmId,
          clientId: client.id,
          channel: 'EMAIL',
          subject,
          body,
          relatedEntityType: 'statement',
        }).catch(() => undefined);
      } catch (err) {
        res.status(502).json({ error: 'email_dispatch_failed' });
        return;
      }
      res.json({ ok: true, sentTo: billingEmail, balanceCents: balance });
    },
  );

  router.get(
    '/snapshots/diff',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const days = Math.min(
        Math.max(parseInt(String(req.query['days'] ?? '30'), 10) || 30, 7),
        365,
      );
      const rows = await deps.db.execute(drizzleSql`
        SELECT
          as_of_date::text                  AS "asOfDate",
          SUM(bucket_0_30_cents)::bigint    AS "b0to30",
          SUM(bucket_31_60_cents)::bigint   AS "b31to60",
          SUM(bucket_61_90_cents)::bigint   AS "b61to90",
          SUM(bucket_90_plus_cents)::bigint AS "b90plus",
          SUM(total_cents)::bigint          AS "total"
        FROM ar_aging_snapshot
        WHERE firm_id = ${session.firmId}
          AND as_of_date >= CURRENT_DATE - ${days}::int
        GROUP BY as_of_date
        ORDER BY as_of_date
      `);
      const arr =
        ((rows as unknown as { rows: unknown[] }).rows as Array<Record<string, string | number>>) ??
        (rows as unknown as Array<Record<string, string | number>>);
      const items = arr.map((r, i) => {
        const prev = arr[i - 1];
        const cur = Number(r['total'] ?? 0);
        const prv = prev ? Number(prev['total'] ?? 0) : 0;
        return {
          asOfDate: r['asOfDate'],
          totalCents: cur,
          deltaFromPrevCents: prv > 0 ? cur - prv : null,
        };
      });
      res.json({ items });
    },
  );

  router.get(
    '/aging/by-service-line',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      // Walk: invoice → primary_engagement → engagement_type → service_line.
      const today = new Date().toISOString().slice(0, 10);
      const rows = await deps.db
        .select({
          invoiceId: invoices.id,
          dueDate: invoices.dueDate,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
          serviceLineId: serviceLines.id,
          serviceLineName: serviceLines.name,
        })
        .from(invoices)
        .innerJoin(engagements, eq(engagements.id, invoices.primaryEngagementId))
        .leftJoin(engagementTypes, eq(engagementTypes.id, engagements.engagementTypeId))
        .leftJoin(serviceLines, eq(serviceLines.id, engagementTypes.serviceLineId))
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
          ),
        );
      type LineAging = {
        id: string;
        name: string;
        buckets: Record<AgingBucket, number>;
        total: number;
      };
      const map = new Map<string, LineAging>();
      for (const r of rows) {
        const key = r.serviceLineId ?? 'unassigned';
        const name = r.serviceLineName ?? '(no service line)';
        const balance = Number(r.totalCents) - Number(r.paidCents);
        if (balance <= 0) continue;
        const cur = map.get(key) ?? { id: key, name, buckets: emptyBuckets(), total: 0 };
        const days = r.dueDate
          ? Math.max(0, Math.floor((Date.parse(today) - Date.parse(r.dueDate)) / 86_400_000))
          : 0;
        const b: AgingBucket =
          days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
        cur.buckets[b] += balance;
        cur.total += balance;
        map.set(key, cur);
      }
      res.json({
        asOf: today,
        items: Array.from(map.values()).sort((a, b) => b.total - a.total),
      });
    },
  );

  return router;
}

async function loadAging(
  db: Database,
  firmId: string,
  opts: { partnerId?: string; clientId?: string } = {},
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
  if (opts.clientId) {
    conds.push(eq(clients.id, opts.clientId));
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
  return csvField(s);
}

function emptyBuckets(): Record<AgingBucket, number> {
  return { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
}
