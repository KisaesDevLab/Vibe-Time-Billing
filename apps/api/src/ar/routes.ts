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
}

interface ClientAging {
  clientId: string;
  clientName: string;
  buckets: Record<AgingBucket, number>;
  total: number;
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
      const today = new Date().toISOString().slice(0, 10);
      const outstanding = await deps.db
        .select({
          id: invoices.id,
          dueDate: invoices.dueDate,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
          clientId: invoices.clientId,
          clientName: clients.name,
        })
        .from(invoices)
        .innerJoin(clients, eq(clients.id, invoices.clientId))
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
            ne(invoices.status, 'VOIDED'),
          ),
        )
        .orderBy(desc(invoices.dueDate));

      // Group by client, bucket each invoice's outstanding balance by days past due.
      const byClient = new Map<
        string,
        { name: string; rows: { entryDate: string; amountCents: number }[] }
      >();
      for (const inv of outstanding) {
        const balance = Number(inv.totalCents) - Number(inv.paidCents);
        if (balance <= 0) continue;
        const arr = byClient.get(inv.clientId) ?? { name: inv.clientName, rows: [] };
        arr.rows.push({ entryDate: inv.dueDate, amountCents: balance });
        byClient.set(inv.clientId, arr);
      }
      const clientsOut: ClientAging[] = [];
      const totals = emptyBuckets();
      for (const [clientId, v] of byClient) {
        const b = bucketize(v.rows, today);
        const total = b['0-30'] + b['31-60'] + b['61-90'] + b['90+'];
        clientsOut.push({ clientId, clientName: v.name, buckets: b, total });
        totals['0-30'] += b['0-30'];
        totals['31-60'] += b['31-60'];
        totals['61-90'] += b['61-90'];
        totals['90+'] += b['90+'];
      }
      clientsOut.sort((a, b) => b.total - a.total);
      res.json({ asOf: today, totals, clients: clientsOut });
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

  return router;
}

function emptyBuckets(): Record<AgingBucket, number> {
  return { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
}
