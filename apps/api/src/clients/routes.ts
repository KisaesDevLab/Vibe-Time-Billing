// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client management (Phase 6).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientContacts,
  clientNotes,
  clientPortalAccess,
  clientRateOverrides,
  clients,
  engagements,
  invoices,
  portalInvitation,
  portalSession,
  userPinnedClients,
} from '@vibe/db/schema';
import { asc, desc } from 'drizzle-orm';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import type { StorageAdapter } from '../files/storage';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { mountCommunicationRoutes } from './communications';
import { mountContactRoutes } from './contacts';
import { mountFileRoutes } from './files';
// Phase 9 — folder-rename / SSE-progress endpoints. v1 folder tree
// was removed in Phase 0.
import { mountFolderRoutes } from './folder';
import { mountTaskRoutes } from './tasks';

import type { Redis } from 'ioredis';

export interface ClientRoutesDeps extends RbacDeps {
  db: Database | null;
  /** v2 Sprint C — file storage adapter for /clients/:id/files. */
  storage?: StorageAdapter;
  /** Phase 9 — required to enqueue folder-mutation jobs + drive the SSE
   *  progress channel. The api passes deps.redis straight through. */
  redis?: Redis;
}

const ClientSchema = z.object({
  name: z.string().min(1).max(200),
  partnerInChargeId: z.string().uuid(),
  // v2 0027 — billing-contact fields moved off client onto client_contact.
  // Callers create the contact via /clients/:id/contacts.
  termsDays: z.number().int().min(0).max(365).optional(),
  invoiceConsolidationPreference: z.enum(['CONSOLIDATED', 'SEPARATE']).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  // v2 Sprint B (0026) — CRM expansion fields.
  clientType: z.enum(['INDIVIDUAL', 'BUSINESS']).optional(),
  clientFacingName: z.string().max(200).nullable().optional(),
  externalId: z.string().max(120).nullable().optional(),
  filingStatus: z.enum(['SINGLE', 'MFJ', 'MFS', 'HOH', 'QW']).nullable().optional(),
  sourceId: z.string().uuid().nullable().optional(),
  pipelineStage: z.enum(['PROSPECT', 'CLIENT', 'OTHER']).optional(),
  active: z.boolean().optional(),
  // 0050 — structured mailing address. All optional, nullable.
  mailingStreet1: z.string().max(200).nullable().optional(),
  mailingStreet2: z.string().max(200).nullable().optional(),
  mailingCity: z.string().max(120).nullable().optional(),
  mailingState: z.string().max(120).nullable().optional(),
  mailingPostal: z.string().max(40).nullable().optional(),
  mailingCountry: z.string().max(120).nullable().optional(),
});

const MergeSchema = z.object({
  sourceId: z.string().uuid(),
  reason: z.string().max(2000).optional(),
});

export function createClientRouter(deps: ClientRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'client:read'), async (req: Request, res: Response) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ items: [] });
      return;
    }
    const q = (req.query['q'] ?? '').toString().trim();
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
    const partnerId = typeof req.query['partnerId'] === 'string' ? req.query['partnerId'] : null;
    // 0050 — new filters
    const clientOwnerId =
      typeof req.query['clientOwnerId'] === 'string' ? req.query['clientOwnerId'] : null;
    const externalId = typeof req.query['externalId'] === 'string' ? req.query['externalId'] : null;
    const clientType = typeof req.query['clientType'] === 'string' ? req.query['clientType'] : null;

    const conds = [eq(clients.firmId, firmId)];
    if (q) {
      // 0050 — expand search to name, externalId, custom_fields (any
      // value, via jsonb::text cast), and contacts (email/phone) via
      // EXISTS subquery. GIN index keeps the custom-fields path cheap.
      const like = `%${q}%`;
      const contactMatch = sql`EXISTS (
        SELECT 1 FROM client_contact cc
        WHERE cc.client_id = ${clients.id}
        AND (cc.email ILIKE ${like} OR cc.phone ILIKE ${like} OR cc.mobile ILIKE ${like})
      )`;
      const customMatch = sql`${clients.customFields}::text ILIKE ${like}`;
      const expr = or(
        ilike(clients.name, like),
        ilike(clients.externalId, like),
        ilike(clients.clientFacingName, like),
        contactMatch,
        customMatch,
      );
      if (expr) conds.push(expr);
    }
    if (
      status === 'ACTIVE' ||
      status === 'ARCHIVED' ||
      status === 'PROSPECT' ||
      status === 'INACTIVE'
    ) {
      conds.push(eq(clients.status, status));
    }
    if (partnerId) conds.push(eq(clients.partnerInChargeId, partnerId));
    if (clientOwnerId) conds.push(eq(clients.partnerInChargeId, clientOwnerId));
    if (externalId) conds.push(eq(clients.externalId, externalId));
    if (clientType === 'INDIVIDUAL' || clientType === 'BUSINESS') {
      conds.push(eq(clients.clientType, clientType));
    }

    // Pagination + sort. If no `page` is supplied, we keep the legacy
    // shape (just `items`, limit 500) so existing callers don't break.
    const paginated = req.query['page'] != null;
    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
    const pageSize = Math.min(
      500,
      Math.max(1, parseInt(String(req.query['pageSize'] ?? '50'), 10) || 50),
    );
    const sortCol = String(req.query['sort'] ?? 'name');
    const sortDir = String(req.query['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc';
    const sortMap: Record<string, ReturnType<typeof sql>> = {
      name: sql`${clients.name}`,
      externalId: sql`${clients.externalId}`,
      clientType: sql`${clients.clientType}`,
      status: sql`${clients.status}`,
      createdAt: sql`${clients.createdAt}`,
      partnerName: sql`${appUsers.fullName}`,
    };
    const orderExpr = sortMap[sortCol] ?? sortMap['name']!;

    const baseSelect = deps.db
      .select({
        id: clients.id,
        name: clients.name,
        status: clients.status,
        clientType: clients.clientType,
        externalId: clients.externalId,
        partnerInChargeId: clients.partnerInChargeId,
        partnerName: appUsers.fullName,
        termsDays: clients.termsDays,
        invoiceConsolidationPreference: clients.invoiceConsolidationPreference,
        createdAt: clients.createdAt,
        mailingCity: clients.mailingCity,
        mailingState: clients.mailingState,
      })
      .from(clients)
      .leftJoin(appUsers, eq(appUsers.id, clients.partnerInChargeId));

    if (!paginated) {
      const items = await baseSelect
        .where(and(...conds))
        .orderBy(sortDir === 'asc' ? asc(orderExpr) : desc(orderExpr))
        .limit(500);
      res.json({ items });
      return;
    }

    const totalRows = await deps.db
      .select({ total: sql<number>`COUNT(*)`.as('total') })
      .from(clients)
      .where(and(...conds));
    const total = Number(totalRows[0]?.total ?? 0);

    const rows = await baseSelect
      .where(and(...conds))
      .orderBy(sortDir === 'asc' ? asc(orderExpr) : desc(orderExpr))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    res.json({ rows, items: rows, total, page, pageSize });
  });

  router.get(
    '/:id',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ client: null });
        return;
      }
      const [client] = await deps.db
        .select()
        .from(clients)
        .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ client });
    },
  );

  router.post('/', requirePermission(deps, 'client:write'), async (req: Request, res: Response) => {
    const parsed = ClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.status(201).json({ ok: true });
      return;
    }
    const session = req.staffSession!;
    const [row] = await deps.db
      .insert(clients)
      .values({ firmId, ...parsed.data })
      .returning({ id: clients.id });
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'client',
      entityId: row?.id,
      actorAppUserId: session.appUserId,
      after: parsed.data,
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.status(201).json({ id: row?.id });
  });

  router.patch(
    '/:id',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const parsed = ClientSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      await deps.db
        .update(clients)
        .set(parsed.data)
        .where(and(eq(clients.firmId, firmId), eq(clients.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // Legal-hold toggle (Phase 19 #12). When set, archive is blocked and
  // the retention worker preserves audit + ai_request_log entries.
  router.post(
    '/:id/legal-hold',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { enabled?: unknown; reason?: unknown };
      const enabled = body.enabled === true;
      const reason = enabled && typeof body.reason === 'string' ? body.reason.slice(0, 1000) : null;
      await deps.db
        .update(clients)
        .set({
          legalHoldFlag: enabled,
          legalHoldReason: reason,
          legalHoldSetAt: enabled ? new Date() : null,
        })
        .where(and(eq(clients.firmId, firmId), eq(clients.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { kind: 'legal_hold', enabled, reason },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, legalHoldFlag: enabled });
    },
  );

  router.patch(
    '/:id/archive',
    requirePermission(deps, 'client:archive'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      // Phase 19 #12 — legal-hold blocks archive.
      const [c] = await deps.db
        .select({ legalHoldFlag: clients.legalHoldFlag })
        .from(clients)
        .where(and(eq(clients.firmId, firmId), eq(clients.id, req.params['id']!)))
        .limit(1);
      if (c?.legalHoldFlag) {
        res.status(409).json({ error: 'legal_hold_active' });
        return;
      }
      await deps.db
        .update(clients)
        .set({ status: 'ARCHIVED' })
        .where(and(eq(clients.firmId, firmId), eq(clients.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: 'ARCHIVED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/bulk-import',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, created: 0 });
        return;
      }
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
      const partnerInChargeId =
        typeof req.body?.defaultPartnerId === 'string' ? req.body.defaultPartnerId : null;
      if (!rows || rows.length === 0 || !partnerInChargeId) {
        res.status(400).json({ error: 'rows_and_default_partner_required' });
        return;
      }
      const created: string[] = [];
      const skipped: { row: number; reason: string }[] = [];
      for (let i = 0; i < rows.length && i < 1000; i++) {
        const r = rows[i] as Record<string, unknown>;
        const name =
          typeof r['name'] === 'string' && r['name'].trim() ? r['name'].slice(0, 200) : null;
        if (!name) {
          skipped.push({ row: i, reason: 'missing_name' });
          continue;
        }
        try {
          const [newRow] = await deps.db
            .insert(clients)
            .values({
              firmId,
              name,
              partnerInChargeId,
              termsDays: typeof r['termsDays'] === 'number' ? r['termsDays'] : 30,
            })
            .returning({ id: clients.id });
          if (newRow) {
            created.push(newRow.id);
            // v2 0027 — seed an isPrimary/isBilling contact row from
            // any billing fields the import provided.
            const email =
              typeof r['billingContactEmail'] === 'string' ? r['billingContactEmail'] : null;
            const phone =
              typeof r['billingContactPhone'] === 'string' ? r['billingContactPhone'] : null;
            const contactName =
              typeof r['billingContactName'] === 'string' && r['billingContactName'].trim()
                ? r['billingContactName']
                : name;
            await deps.db.insert(clientContacts).values({
              clientId: newRow.id,
              fullName: contactName,
              email,
              phone,
              isPrimary: true,
              isBilling: Boolean(email || phone),
            });
          }
        } catch (err) {
          skipped.push({
            row: i,
            reason: err instanceof Error ? err.message.slice(0, 200) : 'insert_failed',
          });
        }
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client',
        actorAppUserId: session.appUserId,
        after: { kind: 'bulk_import', created: created.length, skipped: skipped.length },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ created: created.length, createdIds: created, skipped });
    },
  );

  router.get(
    '/export.csv',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.send('id,name,status\n');
        return;
      }
      // v2 0027 — billing email/phone now live on client_contact. Join
      // the isBilling row so the CSV layout stays the same as v1.
      const items = await deps.db
        .select({
          id: clients.id,
          name: clients.name,
          status: clients.status,
          billingContactEmail: clientContacts.email,
          billingContactPhone: clientContacts.phone,
          termsDays: clients.termsDays,
          createdAt: clients.createdAt,
        })
        .from(clients)
        .leftJoin(
          clientContacts,
          and(eq(clientContacts.clientId, clients.id), eq(clientContacts.isBilling, true)),
        )
        .where(eq(clients.firmId, firmId))
        .limit(10000);
      const header = [
        'id',
        'name',
        'status',
        'billing_email',
        'billing_phone',
        'terms_days',
        'created_at',
      ];
      const lines = [header.join(',')];
      for (const c of items) {
        lines.push(
          [
            c.id,
            csvCell(c.name),
            c.status,
            csvCell(c.billingContactEmail ?? ''),
            csvCell(c.billingContactPhone ?? ''),
            String(c.termsDays),
            c.createdAt.toISOString(),
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="clients-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(lines.join('\n') + '\n');
    },
  );

  router.get(
    '/:id/notes',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select()
        .from(clientNotes)
        .where(eq(clientNotes.clientId, client.id))
        .orderBy(desc(clientNotes.pinned), desc(clientNotes.createdAt))
        .limit(200);
      res.json({ items });
    },
  );

  router.delete(
    '/:id/notes/:noteId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .delete(clientNotes)
        .where(and(eq(clientNotes.id, req.params['noteId']!), eq(clientNotes.clientId, client.id)));
      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id/notes/:noteId/pin',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const pinned = req.body?.pinned === true;
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(clientNotes)
        .set({ pinned })
        .where(and(eq(clientNotes.id, req.params['noteId']!), eq(clientNotes.clientId, client.id)));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/notes',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const body = typeof req.body?.body === 'string' ? req.body.body.slice(0, 8000) : null;
      if (!body) {
        res.status(400).json({ error: 'body_required' });
        return;
      }
      const pinned = req.body?.pinned === true;
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(clientNotes)
        .values({ clientId: client.id, authorId: session.appUserId, body, pinned })
        .returning({ id: clientNotes.id });
      res.status(201).json({ id: row?.id });
    },
  );

  // Phase 6 #8 — client merge / dedup tool.
  // POST /:targetId/merge with body { sourceId, reason? }.
  // Re-points every FK from source → target (engagements, invoices,
  // client_rate_overrides, client_notes, client_portal_access,
  // portal_invitation, portal_session.activeClientId), then archives
  // source. Refuses if either client is legal-held. Audit log captures
  // before/after on both clients + counts of moved rows.
  router.post(
    '/:id/merge',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const targetId = req.params['id']!;
      const parsed = MergeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const sourceId = parsed.data.sourceId;
      if (sourceId === targetId) {
        res.status(400).json({ error: 'cannot_merge_into_self' });
        return;
      }
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const both = await deps.db
        .select({
          id: clients.id,
          name: clients.name,
          legalHoldFlag: clients.legalHoldFlag,
        })
        .from(clients)
        .where(and(eq(clients.firmId, session.firmId), inArray(clients.id, [sourceId, targetId])));
      const target = both.find((c) => c.id === targetId);
      const source = both.find((c) => c.id === sourceId);
      if (!target || !source) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      if (target.legalHoldFlag || source.legalHoldFlag) {
        res.status(409).json({ error: 'legal_hold_active' });
        return;
      }
      const counts = await deps.db.transaction(async (tx) => {
        const moved = {
          engagements: 0,
          invoices: 0,
          clientRateOverrides: 0,
          clientNotes: 0,
          portalAccesses: 0,
          portalInvitations: 0,
          portalSessions: 0,
        };
        const upEngs = await tx
          .update(engagements)
          .set({ clientId: targetId })
          .where(eq(engagements.clientId, sourceId))
          .returning({ id: engagements.id });
        moved.engagements = upEngs.length;

        const upInvs = await tx
          .update(invoices)
          .set({ clientId: targetId })
          .where(eq(invoices.clientId, sourceId))
          .returning({ id: invoices.id });
        moved.invoices = upInvs.length;

        const upRates = await tx
          .update(clientRateOverrides)
          .set({ clientId: targetId })
          .where(eq(clientRateOverrides.clientId, sourceId))
          .returning({ id: clientRateOverrides.id });
        moved.clientRateOverrides = upRates.length;

        const upNotes = await tx
          .update(clientNotes)
          .set({ clientId: targetId })
          .where(eq(clientNotes.clientId, sourceId))
          .returning({ id: clientNotes.id });
        moved.clientNotes = upNotes.length;

        const upAccess = await tx
          .update(clientPortalAccess)
          .set({ clientId: targetId })
          .where(eq(clientPortalAccess.clientId, sourceId))
          .returning({ id: clientPortalAccess.id });
        moved.portalAccesses = upAccess.length;

        const upInvites = await tx
          .update(portalInvitation)
          .set({ clientId: targetId })
          .where(eq(portalInvitation.clientId, sourceId))
          .returning({ id: portalInvitation.id });
        moved.portalInvitations = upInvites.length;

        const upSessions = await tx
          .update(portalSession)
          .set({ activeClientId: targetId })
          .where(eq(portalSession.activeClientId, sourceId))
          .returning({ id: portalSession.id });
        moved.portalSessions = upSessions.length;

        await tx.update(clients).set({ status: 'ARCHIVED' }).where(eq(clients.id, sourceId));
        return moved;
      });

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client',
        entityId: targetId,
        actorAppUserId: session.appUserId,
        before: { merged_source_id: sourceId, source_name: source.name },
        after: {
          kind: 'merge_target',
          sourceId,
          sourceName: source.name,
          reason: parsed.data.reason ?? null,
          moved: counts,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client',
        entityId: sourceId,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'merged_into',
          targetId,
          targetName: target.name,
          reason: parsed.data.reason ?? null,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, targetId, sourceId, moved: counts });
    },
  );

  // Bulk archive (or unarchive). Body: { clientIds: string[], status: 'ARCHIVED' | 'ACTIVE' }
  router.post(
    '/bulk-status',
    requirePermission(deps, 'client:archive'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ updated: 0 });
        return;
      }
      const body = req.body as { clientIds?: unknown; status?: unknown };
      const ids = Array.isArray(body.clientIds)
        ? body.clientIds.filter((x): x is string => typeof x === 'string')
        : [];
      const status = body.status === 'ARCHIVED' || body.status === 'ACTIVE' ? body.status : null;
      if (ids.length === 0 || !status) {
        res.status(400).json({ error: 'clientIds_and_status_required' });
        return;
      }
      const updated = await deps.db
        .update(clients)
        .set({ status })
        .where(and(eq(clients.firmId, session.firmId), inArray(clients.id, ids)))
        .returning({ id: clients.id });
      res.json({ updated: updated.length });
    },
  );

  // v2 followup — pinned clients (per-timekeeper). GET returns the
  // caller's pinned list; POST upserts a pin; DELETE removes one.
  router.get(
    '/pins',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession;
      if (!session || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({ clientId: userPinnedClients.clientId, pinnedAt: userPinnedClients.pinnedAt })
        .from(userPinnedClients)
        .where(eq(userPinnedClients.appUserId, session.appUserId));
      res.json({ items });
    },
  );

  router.post(
    '/pins',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = (req.body ?? {}) as { clientId?: string };
      const clientId = typeof body.clientId === 'string' ? body.clientId : '';
      if (!clientId) {
        res.status(400).json({ error: 'clientId_required' });
        return;
      }
      await deps.db
        .insert(userPinnedClients)
        .values({ appUserId: session.appUserId, clientId })
        .onConflictDoNothing();
      res.json({ ok: true });
    },
  );

  router.delete(
    '/pins/:clientId',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .delete(userPinnedClients)
        .where(
          and(
            eq(userPinnedClients.appUserId, session.appUserId),
            eq(userPinnedClients.clientId, req.params['clientId']!),
          ),
        );
      res.json({ ok: true });
    },
  );

  // v2 Sprint B — multi-contact CRUD endpoints (workstream 1.2).
  mountContactRoutes(router, deps);

  // v2 Sprint C — tasks (1.3) + communications (1.5).
  mountTaskRoutes(router, deps);
  // Phase 8 of FILE_MANAGER_ADDENDUM.md — app upload path. The new
  // file-routes module builds its own StorageClient via buildStorageClient
  // (Mock in dev, B2 in prod) so we don't depend on the legacy
  // storage adapter that backs v1 attachments.
  mountFileRoutes(router, { ...deps });
  // Phase 9 of FILE_MANAGER_ADDENDUM.md — folder-rename + SSE progress.
  // Skipped when redis is missing (tests with no real Redis); the
  // routes 503 if the queue can't be built lazily either way.
  if (deps.redis) {
    mountFolderRoutes(router, { ...deps, redis: deps.redis });
  }
  mountCommunicationRoutes(router, deps);

  // v1 folder routes removed in Phase 0 of the file-manager rebuild.
  // Phase 4 (storage onboarding) introduces a new admin-scoped route
  // table; Phase 10 wires the per-client UI.

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
