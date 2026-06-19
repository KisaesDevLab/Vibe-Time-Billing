// SPDX-License-Identifier: Elastic-2.0
//
// Firm- and engagement-level summary stats for the staff dashboard.
// All numbers computed live from the canonical tables — for firms over
// the 100k-time-entry threshold, swap these to read from the materialized
// realization_view in packages/db/migrations/0003_materialized_views.sql.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  approvalRequests,
  bookingRequests,
  staffNotifications,
  clientRequests,
  clients,
  engagements,
  intakeSessions,
  invoices,
  messageReadReceipts,
  messages,
  payments,
  threadMembers,
  threads,
  timeEntries,
} from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface StatsRoutesDeps extends RbacDeps {
  db: Database | null;
}

export function createStatsRouter(deps: StatsRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/firm',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ summary: null });
        return;
      }
      const monthStart = new Date(Date.now() - 30 * 86_400_000);
      const [clientStats] = await deps.db
        .select({ c: sql<number>`COUNT(*)` })
        .from(clients)
        .where(and(eq(clients.firmId, session.firmId), eq(clients.status, 'ACTIVE')));
      const firmClientIds = (
        await deps.db
          .select({ id: clients.id })
          .from(clients)
          .where(eq(clients.firmId, session.firmId))
      ).map((c) => c.id);
      const engStats = firmClientIds.length
        ? await deps.db
            .select({ c: sql<number>`COUNT(*)` })
            .from(engagements)
            .where(
              and(inArray(engagements.clientId, firmClientIds), eq(engagements.status, 'ACTIVE')),
            )
        : [{ c: 0 }];
      const [arOutstanding] = await deps.db
        .select({
          total: sql<number>`COALESCE(SUM(${invoices.totalCents} - ${invoices.paidCents}), 0)`,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
          ),
        );
      const [paidThisMonth] = await deps.db
        .select({
          total: sql<number>`COALESCE(SUM(${payments.amountCents} - COALESCE(${payments.refundedAmountCents}, 0)), 0)`,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            gte(payments.receivedAt, monthStart),
            eq(payments.status, 'SUCCEEDED'),
          ),
        );
      const [wipHours] = firmClientIds.length
        ? await deps.db
            .select({
              h: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
              amount: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
            })
            .from(timeEntries)
            .innerJoin(engagements, eq(engagements.id, timeEntries.engagementId))
            .where(
              and(
                inArray(engagements.clientId, firmClientIds),
                eq(timeEntries.status, 'SUBMITTED'),
              ),
            )
        : [{ h: '0', amount: 0 }];
      res.json({
        summary: {
          activeClients: Number(clientStats?.c ?? 0),
          activeEngagements: Number(engStats[0]?.c ?? 0),
          arOutstandingCents: Number(arOutstanding?.total ?? 0),
          collectionsLast30DaysCents: Number(paidThisMonth?.total ?? 0),
          wipHours: Number(wipHours?.h ?? 0),
          wipAmountCents: Number(wipHours?.amount ?? 0),
        },
      });
    },
  );

  // Dashboard "inbox" card — unread/pending counts across the staff
  // surfaces the signed-in user can act on. Gate on messaging:read (held
  // by every staff role) since this is per-user attention, not firm KPIs.
  router.get(
    '/inbox-counts',
    requirePermission(deps, 'messaging:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const empty = {
        clientMsg: 0,
        teamMsg: 0,
        requests: 0,
        intake: 0,
        approvals: 0,
        notifications: 0,
        bookingRequests: 0,
      };
      if (!deps.db) {
        res.json(empty);
        return;
      }
      const { firmId, appUserId } = session;
      const n = (rows: { c: number }[]): number => Number(rows[0]?.c ?? 0);

      // Unread client (engagement) messages: in client threads I'm an
      // active member of, not sent by me, with no read receipt from me.
      const clientMsg = await deps.db
        .select({ c: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(threads, eq(threads.id, messages.threadId))
        .innerJoin(threadMembers, eq(threadMembers.threadId, threads.id))
        .leftJoin(
          messageReadReceipts,
          and(
            eq(messageReadReceipts.messageId, messages.id),
            eq(messageReadReceipts.readerAppUserId, appUserId),
          ),
        )
        .where(
          and(
            eq(threads.firmId, firmId),
            eq(threads.kind, 'client'),
            eq(threadMembers.appUserId, appUserId),
            isNull(threadMembers.removedAt),
            isNull(messages.deletedAt),
            ne(messages.senderAppUserId, appUserId),
            isNull(messageReadReceipts.id),
          ),
        );

      // Unread team (internal) messages via the per-member read cursor.
      const teamMsg = await deps.db
        .select({ c: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(threads, eq(threads.id, messages.threadId))
        .innerJoin(threadMembers, eq(threadMembers.threadId, threads.id))
        .where(
          and(
            eq(threads.firmId, firmId),
            eq(threads.kind, 'internal'),
            eq(threadMembers.appUserId, appUserId),
            isNull(threadMembers.removedAt),
            isNull(messages.deletedAt),
            ne(messages.senderAppUserId, appUserId),
            sql`(${threadMembers.lastReadAt} IS NULL OR ${messages.createdAt} > ${threadMembers.lastReadAt})`,
          ),
        );

      const requests = await deps.db
        .select({ c: sql<number>`count(*)::int` })
        .from(clientRequests)
        .where(
          and(
            eq(clientRequests.firmId, firmId),
            inArray(clientRequests.status, ['OPEN', 'NEEDS_INFO']),
          ),
        );

      const intake = await deps.db
        .select({ c: sql<number>`count(*)::int` })
        .from(intakeSessions)
        .where(and(eq(intakeSessions.firmId, firmId), eq(intakeSessions.status, 'received')));

      // Single-firm appliance → all PENDING approvals belong to this firm.
      const approvals = await deps.db
        .select({ c: sql<number>`count(*)::int` })
        .from(approvalRequests)
        .where(eq(approvalRequests.status, 'PENDING'));

      // BK-7 — unread in-app notifications for this staff user.
      const notifications = await deps.db
        .select({ c: sql<number>`count(*)::int` })
        .from(staffNotifications)
        .where(
          and(
            eq(staffNotifications.recipientAppUserId, appUserId),
            eq(staffNotifications.status, 'UNREAD'),
          ),
        );

      // Pending public booking requests awaiting a staff decision.
      const bookingReqs = await deps.db
        .select({ c: sql<number>`count(*)::int` })
        .from(bookingRequests)
        .where(and(eq(bookingRequests.firmId, firmId), eq(bookingRequests.status, 'PENDING')));

      res.json({
        clientMsg: n(clientMsg),
        teamMsg: n(teamMsg),
        requests: n(requests),
        intake: n(intake),
        approvals: n(approvals),
        notifications: n(notifications),
        bookingRequests: n(bookingReqs),
      });
    },
  );

  router.get(
    '/engagement/:engagementId',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ summary: null });
        return;
      }
      const [scope] = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(eq(engagements.id, req.params['engagementId']!), eq(clients.firmId, session.firmId)),
        )
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const [te] = await deps.db
        .select({
          totalEntries: sql<number>`COUNT(*)`,
          totalHours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
          totalAmountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
          submittedCount: sql<number>`COUNT(*) FILTER (WHERE ${timeEntries.status} = 'SUBMITTED')`,
          billedCount: sql<number>`COUNT(*) FILTER (WHERE ${timeEntries.status} = 'BILLED')`,
        })
        .from(timeEntries)
        .where(eq(timeEntries.engagementId, req.params['engagementId']!));
      const [inv] = await deps.db
        .select({
          invoicedCents: sql<number>`COALESCE(SUM(${invoices.totalCents}), 0)`,
          paidCents: sql<number>`COALESCE(SUM(${invoices.paidCents}), 0)`,
          openCount: sql<number>`COUNT(*) FILTER (WHERE ${invoices.status} IN ('SENT', 'PARTIALLY_PAID', 'OVERDUE'))`,
        })
        .from(invoices)
        .where(eq(invoices.primaryEngagementId, req.params['engagementId']!));
      res.json({
        summary: {
          engagementId: req.params['engagementId'],
          timeEntries: {
            total: Number(te?.totalEntries ?? 0),
            totalHours: Number(te?.totalHours ?? 0),
            totalAmountCents: Number(te?.totalAmountCents ?? 0),
            submittedCount: Number(te?.submittedCount ?? 0),
            billedCount: Number(te?.billedCount ?? 0),
          },
          invoicing: {
            invoicedCents: Number(inv?.invoicedCents ?? 0),
            paidCents: Number(inv?.paidCents ?? 0),
            openCount: Number(inv?.openCount ?? 0),
          },
        },
      });
    },
  );

  router.get(
    '/client/:clientId',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ summary: null });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, req.params['clientId']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [eng] = await deps.db
        .select({
          total: sql<number>`COUNT(*)`,
          activeCount: sql<number>`COUNT(*) FILTER (WHERE ${engagements.status} = 'ACTIVE')`,
          closedCount: sql<number>`COUNT(*) FILTER (WHERE ${engagements.status} = 'CLOSED')`,
        })
        .from(engagements)
        .where(eq(engagements.clientId, req.params['clientId']!));
      const [inv] = await deps.db
        .select({
          count: sql<number>`COUNT(*)`,
          outstandingCents: sql<number>`COALESCE(SUM(${invoices.totalCents} - ${invoices.paidCents}) FILTER (WHERE ${invoices.status} IN ('SENT', 'PARTIALLY_PAID', 'OVERDUE')), 0)`,
          paidCents: sql<number>`COALESCE(SUM(${invoices.paidCents}), 0)`,
          totalCents: sql<number>`COALESCE(SUM(${invoices.totalCents}), 0)`,
        })
        .from(invoices)
        .where(
          and(eq(invoices.firmId, session.firmId), eq(invoices.clientId, req.params['clientId']!)),
        );
      const engRowsForWip = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.clientId, req.params['clientId']!));
      const engIds = engRowsForWip.map((r) => r.id);
      const wip = engIds.length
        ? await deps.db
            .select({
              h: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
              amount: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
            })
            .from(timeEntries)
            .where(
              and(inArray(timeEntries.engagementId, engIds), eq(timeEntries.status, 'SUBMITTED')),
            )
        : [{ h: '0', amount: 0 }];
      res.json({
        summary: {
          clientId: req.params['clientId'],
          engagementCount: Number(eng?.total ?? 0),
          activeEngagementCount: Number(eng?.activeCount ?? 0),
          closedEngagementCount: Number(eng?.closedCount ?? 0),
          invoiceCount: Number(inv?.count ?? 0),
          invoicedCents: Number(inv?.totalCents ?? 0),
          paidCents: Number(inv?.paidCents ?? 0),
          outstandingCents: Number(inv?.outstandingCents ?? 0),
          wipHours: Number(wip[0]?.h ?? 0),
          wipAmountCents: Number(wip[0]?.amount ?? 0),
        },
      });
    },
  );

  return router;
}
