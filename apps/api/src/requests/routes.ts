// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Stage 3 — client request workflow. Staff create + manage; the
// portal-side endpoint (not in this router) handles client
// fulfillment. Routes:
//
//   GET    /                  list requests (filterable)
//   GET    /:id               single request
//   POST   /                  create
//   POST   /:id/fulfill       staff fulfills on client's behalf (e.g.
//                             received via email + uploaded). Inserts
//                             a suggestion link in the assigned
//                             staff's queue.
//   POST   /:id/dismiss       mark dismissed
//   POST   /:id/reopen        flip dismissed → open
//   PATCH  /:id               update title/body/due date
//
//   GET    /suggestions/mine  pending time-entry suggestions for the
//                             logged-in staff
//   POST   /suggestions/:id/accept   accept (creates time entry)
//   POST   /suggestions/:id/dismiss  dismiss

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientRequestTimeEntryLinks,
  clientRequests,
  engagements,
  firmConfig,
  timeEntries,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface RequestRoutesDeps extends RbacDeps {
  db: Database | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CreateSchema = z.object({
  engagementId: z.string().uuid(),
  title: z.string().min(1).max(200),
  body: z.string().max(5000).optional().default(''),
  assignedAppUserId: z.string().uuid().nullable().optional(),
  dueDate: z.string().regex(DATE_RE).nullable().optional(),
});

const PatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(5000).optional(),
  assignedAppUserId: z.string().uuid().nullable().optional(),
  dueDate: z.string().regex(DATE_RE).nullable().optional(),
});

const FulfillSchema = z.object({
  reason: z.string().max(500).optional(),
  messageId: z.string().uuid().nullable().optional(),
  fileId: z.string().uuid().nullable().optional(),
});

const DismissSchema = z.object({
  reason: z.string().max(500).optional(),
});

const AcceptSuggestionSchema = z.object({
  // Caller may pass a freshly-created time_entry_id (already linked
  // by the timer UI). When absent, "accept" just marks the suggestion
  // accepted with no time entry attachment yet — the staff can hit
  // the timer separately.
  timeEntryId: z.string().uuid().nullable().optional(),
});

function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

async function getSuggestionExpirationDays(db: Database, firmId: string): Promise<number> {
  const [row] = await db
    .select({ days: firmConfig.suggestionExpirationDays })
    .from(firmConfig)
    .where(eq(firmConfig.firmId, firmId))
    .limit(1);
  return row?.days ?? 7;
}

export function createRequestRouter(deps: RequestRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'requests:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
    const engagementIdParam = uuidQueryParam(req.query['engagementId']);
    if (engagementIdParam === 'invalid') {
      res.status(400).json({ error: 'invalid_engagement_id' });
      return;
    }
    const conds = [eq(clientRequests.firmId, session.firmId)];
    if (status) conds.push(eq(clientRequests.status, status));
    if (engagementIdParam) conds.push(eq(clientRequests.engagementId, engagementIdParam));
    const items = await deps.db
      .select()
      .from(clientRequests)
      .where(and(...conds))
      .orderBy(desc(clientRequests.createdAt))
      .limit(500);
    if (items.length === 0) {
      res.json({ items: [] });
      return;
    }
    // P2.5 / G.8 — enrich each row with its accepted linked time entry
    // (if any) so the firm-wide queue can render "Linked: X hrs by …"
    // inline without N+1 calls. Left join: most rows have no link.
    const linkRows = await deps.db
      .select({
        clientRequestId: clientRequestTimeEntryLinks.clientRequestId,
        timeEntryId: timeEntries.id,
        hours: timeEntries.hours,
        entryDate: timeEntries.entryDate,
        staffName: appUsers.fullName,
      })
      .from(clientRequestTimeEntryLinks)
      .innerJoin(timeEntries, eq(timeEntries.id, clientRequestTimeEntryLinks.timeEntryId))
      .leftJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
      .where(
        and(
          sql`${clientRequestTimeEntryLinks.acceptedAt} IS NOT NULL`,
          sql`${clientRequestTimeEntryLinks.timeEntryId} IS NOT NULL`,
          inArray(
            clientRequestTimeEntryLinks.clientRequestId,
            items.map((i) => i.id),
          ),
        ),
      );
    const linkByRequest = new Map<string, (typeof linkRows)[number]>();
    for (const r of linkRows) linkByRequest.set(r.clientRequestId, r);
    const enriched = items.map((it) => {
      const link = linkByRequest.get(it.id);
      return {
        ...it,
        linkedTimeEntry: link
          ? {
              id: link.timeEntryId,
              hours: link.hours,
              entryDate: link.entryDate,
              staffName: link.staffName,
            }
          : null,
      };
    });
    res.json({ items: enriched });
  });

  router.get(
    '/:id',
    requirePermission(deps, 'requests:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(clientRequests)
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // P2.3 — resolve the linked time entry (if any) for the request's
      // accepted suggestion. Surfaces in the staff request-detail UI as
      // "Linked time entry: X hrs by [staff]" per G.8.
      const linkedRows = await deps.db
        .select({
          timeEntryId: timeEntries.id,
          hours: timeEntries.hours,
          entryDate: timeEntries.entryDate,
          appUserId: timeEntries.appUserId,
          staffName: appUsers.fullName,
        })
        .from(clientRequestTimeEntryLinks)
        .innerJoin(timeEntries, eq(timeEntries.id, clientRequestTimeEntryLinks.timeEntryId))
        .leftJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
        .where(
          and(
            eq(clientRequestTimeEntryLinks.clientRequestId, row.id),
            sql`${clientRequestTimeEntryLinks.timeEntryId} IS NOT NULL`,
            sql`${clientRequestTimeEntryLinks.acceptedAt} IS NOT NULL`,
          ),
        )
        .limit(1);
      const linkedTimeEntry = linkedRows[0]
        ? {
            id: linkedRows[0].timeEntryId,
            hours: linkedRows[0].hours,
            entryDate: linkedRows[0].entryDate,
            staffName: linkedRows[0].staffName,
          }
        : null;
      res.json({ request: row, linkedTimeEntry });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [eng] = await deps.db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, parsed.data.engagementId))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(clientRequests)
        .values({
          firmId: session.firmId,
          engagementId: parsed.data.engagementId,
          assignedAppUserId: parsed.data.assignedAppUserId ?? null,
          title: parsed.data.title,
          body: parsed.data.body ?? '',
          dueDate: parsed.data.dueDate ?? null,
          createdByAppUserId: session.appUserId,
        })
        .returning({ id: clientRequests.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_request',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.title !== undefined) patch['title'] = parsed.data.title;
      if (parsed.data.body !== undefined) patch['body'] = parsed.data.body;
      if (parsed.data.assignedAppUserId !== undefined) {
        patch['assignedAppUserId'] = parsed.data.assignedAppUserId;
      }
      if (parsed.data.dueDate !== undefined) patch['dueDate'] = parsed.data.dueDate;
      const updated = await deps.db
        .update(clientRequests)
        .set(patch)
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .returning({ id: clientRequests.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_request',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: patch,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/fulfill',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const parsed = FulfillSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const expirationDays = await getSuggestionExpirationDays(deps.db, session.firmId);
      const expiresAt = new Date(Date.now() + expirationDays * 86_400_000);
      const result = await deps.db.transaction(async (tx) => {
        const [prior] = await tx
          .select()
          .from(clientRequests)
          .where(
            and(
              eq(clientRequests.id, req.params['id']!),
              eq(clientRequests.firmId, session.firmId),
            ),
          )
          .for('update')
          .limit(1);
        if (!prior) return { kind: 'not_found' as const };
        if (prior.status !== 'OPEN') return { kind: 'wrong_status' as const, status: prior.status };
        await tx
          .update(clientRequests)
          .set({
            status: 'FULFILLED',
            fulfilledAt: new Date(),
            fulfilledByAppUserId: session.appUserId,
            fulfilledByMessageId: parsed.data.messageId ?? null,
            fulfilledByFileId: parsed.data.fileId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(clientRequests.id, prior.id));
        // Queue a time-entry suggestion for the assigned staff. If the
        // request had no assignee, suggest to the fulfiller.
        const suggestedFor = prior.assignedAppUserId ?? session.appUserId;
        const [linkRow] = await tx
          .insert(clientRequestTimeEntryLinks)
          .values({
            clientRequestId: prior.id,
            suggestedForAppUserId: suggestedFor,
            expiresAt,
          })
          .returning({ id: clientRequestTimeEntryLinks.id });
        return { kind: 'ok' as const, suggestionId: linkRow?.id };
      });
      if (result.kind === 'not_found') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (result.kind === 'wrong_status') {
        res.status(409).json({ error: 'wrong_status', status: result.status });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_request',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'fulfill',
          messageId: parsed.data.messageId,
          fileId: parsed.data.fileId,
          suggestionId: result.suggestionId,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, suggestionId: result.suggestionId });
    },
  );

  router.post(
    '/:id/dismiss',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const parsed = DismissSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const updated = await deps.db
        .update(clientRequests)
        .set({
          status: 'DISMISSED',
          dismissedAt: new Date(),
          dismissedReason: parsed.data.reason ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(clientRequests.id, req.params['id']!),
            eq(clientRequests.firmId, session.firmId),
            eq(clientRequests.status, 'OPEN'),
          ),
        )
        .returning({ id: clientRequests.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found_or_wrong_status' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_request',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { kind: 'dismiss', reason: parsed.data.reason },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/reopen',
    requirePermission(deps, 'requests:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const updated = await deps.db
        .update(clientRequests)
        .set({
          status: 'OPEN',
          dismissedAt: null,
          dismissedReason: null,
          fulfilledAt: null,
          fulfilledByAppUserId: null,
          fulfilledByPortalIdentityId: null,
          fulfilledByMessageId: null,
          fulfilledByFileId: null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(clientRequests.id, req.params['id']!), eq(clientRequests.firmId, session.firmId)),
        )
        .returning({ id: clientRequests.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'RESTORE',
        entityType: 'client_request',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // -------------------------------------------------------------------
  // Suggestion queue (per-staff)
  // -------------------------------------------------------------------
  router.get(
    '/suggestions/mine',
    requirePermission(deps, 'requests:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({
          id: clientRequestTimeEntryLinks.id,
          clientRequestId: clientRequestTimeEntryLinks.clientRequestId,
          suggestedAt: clientRequestTimeEntryLinks.suggestedAt,
          expiresAt: clientRequestTimeEntryLinks.expiresAt,
          requestTitle: clientRequests.title,
          engagementId: clientRequests.engagementId,
        })
        .from(clientRequestTimeEntryLinks)
        .innerJoin(
          clientRequests,
          eq(clientRequests.id, clientRequestTimeEntryLinks.clientRequestId),
        )
        .where(
          and(
            eq(clientRequestTimeEntryLinks.suggestedForAppUserId, session.appUserId),
            eq(clientRequests.firmId, session.firmId),
            isNull(clientRequestTimeEntryLinks.acceptedAt),
            isNull(clientRequestTimeEntryLinks.dismissedAt),
          ),
        )
        .orderBy(asc(clientRequestTimeEntryLinks.expiresAt));
      res.json({ items });
    },
  );

  router.post(
    '/suggestions/:id/accept',
    requirePermission(deps, 'requests:read'),
    async (req: Request, res: Response) => {
      const parsed = AcceptSuggestionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      // A suggestion needs a time_entry_id to satisfy the state check
      // constraint. Reject accept without it.
      if (!parsed.data.timeEntryId) {
        res.status(400).json({ error: 'time_entry_id_required' });
        return;
      }
      const updated = await deps.db
        .update(clientRequestTimeEntryLinks)
        .set({
          acceptedAt: new Date(),
          timeEntryId: parsed.data.timeEntryId,
        })
        .where(
          and(
            eq(clientRequestTimeEntryLinks.id, req.params['id']!),
            eq(clientRequestTimeEntryLinks.suggestedForAppUserId, session.appUserId),
            isNull(clientRequestTimeEntryLinks.acceptedAt),
            isNull(clientRequestTimeEntryLinks.dismissedAt),
          ),
        )
        .returning({ id: clientRequestTimeEntryLinks.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found_or_already_resolved' });
        return;
      }
      res.json({ ok: true });
    },
  );

  router.post(
    '/suggestions/:id/dismiss',
    requirePermission(deps, 'requests:read'),
    async (req: Request, res: Response) => {
      const parsed = DismissSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const updated = await deps.db
        .update(clientRequestTimeEntryLinks)
        .set({
          dismissedAt: new Date(),
          dismissedReason: parsed.data.reason ?? null,
        })
        .where(
          and(
            eq(clientRequestTimeEntryLinks.id, req.params['id']!),
            eq(clientRequestTimeEntryLinks.suggestedForAppUserId, session.appUserId),
            isNull(clientRequestTimeEntryLinks.acceptedAt),
            isNull(clientRequestTimeEntryLinks.dismissedAt),
          ),
        )
        .returning({ id: clientRequestTimeEntryLinks.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found_or_already_resolved' });
        return;
      }
      res.json({ ok: true });
    },
  );

  return router;
}
