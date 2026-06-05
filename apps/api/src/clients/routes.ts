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
  offices,
  persons,
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
import { mountPeopleRoutes } from './people';
import { mountFileRoutes } from './files';
import { mountClientImportRoutes } from './import';
import { findOrCreatePerson } from './person-helpers';
// Phase 9 — folder-rename / SSE-progress endpoints. v1 folder tree
// was removed in Phase 0.
import { mountFolderRoutes } from './folder';
import { mountFolderLinkRoutes } from './folder-link';
import { mountTaskRoutes } from './tasks';

import type { Redis } from 'ioredis';

export interface ClientRoutesDeps extends RbacDeps {
  db: Database | null;
  /** v2 Sprint C — file storage adapter for /clients/:id/files. */
  storage?: StorageAdapter;
  /** Phase 9 — required to enqueue folder-mutation jobs + drive the SSE
   *  progress channel. The api passes deps.redis straight through. */
  redis?: Redis;
  /** 0092 followup — bulk email dispatch for the /bulk-email endpoint.
   *  Uses the same staff-mail surface as statement / invoice sends so
   *  HTML body + attachments work consistently. Optional so the router
   *  still mounts in test environments without a mailer. */
  sendStaffMail?: (args: {
    to: string;
    subject: string;
    body: string;
    html?: string;
    attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
  }) => Promise<void>;
}

const ClientSchema = z.object({
  name: z.string().min(1).max(200),
  partnerInChargeId: z.string().uuid(),
  // 0092 — every client belongs to one office. Optional on the wire
  // because the create handler resolves a default from the caller's
  // app_user.default_office_id when omitted; patch handler leaves the
  // current value alone when omitted.
  officeId: z.string().uuid().optional(),
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

// Connect I.4 — staff enrolls / re-enrolls / clears a client's tax id
// for portal step-up. The raw value is hashed server-side; the request
// body is never logged.
const TaxIdSchema = z.union([
  z.object({
    kind: z.enum(['ssn_last4', 'ein']),
    value: z.string().min(1).max(32),
  }),
  z.object({ kind: z.literal('clear') }),
]);

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
    const officeId = typeof req.query['officeId'] === 'string' ? req.query['officeId'] : null;

    const conds = [eq(clients.firmId, firmId)];
    if (q) {
      // 0050 — expand search to name, externalId, custom_fields (any
      // value, via jsonb::text cast), and contacts (email/phone) via
      // EXISTS subquery. GIN index keeps the custom-fields path cheap.
      const like = `%${q}%`;
      // 0115 — contact email/phone/mobile live on person (joined here).
      const contactMatch = sql`EXISTS (
        SELECT 1 FROM client_contact cc
        JOIN person p ON p.id = cc.person_id
        WHERE cc.client_id = ${clients.id}
        AND (p.email ILIKE ${like} OR p.phone ILIKE ${like} OR p.mobile ILIKE ${like})
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
    if (officeId) {
      conds.push(eq(clients.officeId, officeId));
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
      // Reuse the same correlated subquery as the SELECT projection
      // (defined just below) so sort matches what the user sees.
      outstandingBalanceCents: sql`COALESCE((
        SELECT SUM(${invoices.totalCents} - ${invoices.paidCents})
        FROM ${invoices}
        WHERE ${invoices.clientId} = ${clients.id}
          AND ${invoices.status} IN ('SENT', 'PARTIALLY_PAID', 'OVERDUE')
      ), 0)`,
    };
    const orderExpr = sortMap[sortCol] ?? sortMap['name']!;

    // Per-client outstanding balance — sum of (totalCents − paidCents)
    // for invoices still owed by the client. Mirrors the formula used
    // in apps/api/src/stats/routes.ts so list + detail agree.
    const outstandingExpr = sql<number>`COALESCE((
      SELECT SUM(${invoices.totalCents} - ${invoices.paidCents})
      FROM ${invoices}
      WHERE ${invoices.clientId} = ${clients.id}
        AND ${invoices.status} IN ('SENT', 'PARTIALLY_PAID', 'OVERDUE')
    ), 0)`.as('outstanding_balance_cents');

    // Per-client portal-access tag — the first ACTIVE access id for
    // this client (or NULL when none). Drives the Clients list status
    // pill styling + click-to-view-as behaviour.
    const portalAccessExpr = sql<string | null>`(
      SELECT cpa.id::text
      FROM client_portal_access cpa
      WHERE cpa.client_id = ${clients.id}
        AND cpa.status = 'ACTIVE'
      ORDER BY cpa.created_at ASC
      LIMIT 1
    )`.as('active_portal_access_id');

    const baseSelect = deps.db
      .select({
        id: clients.id,
        name: clients.name,
        status: clients.status,
        clientType: clients.clientType,
        externalId: clients.externalId,
        partnerInChargeId: clients.partnerInChargeId,
        partnerName: appUsers.fullName,
        officeId: clients.officeId,
        officeName: offices.name,
        termsDays: clients.termsDays,
        invoiceConsolidationPreference: clients.invoiceConsolidationPreference,
        createdAt: clients.createdAt,
        mailingCity: clients.mailingCity,
        mailingState: clients.mailingState,
        outstandingBalanceCents: outstandingExpr,
        activePortalAccessId: portalAccessExpr,
      })
      .from(clients)
      .leftJoin(appUsers, eq(appUsers.id, clients.partnerInChargeId))
      .leftJoin(offices, eq(offices.id, clients.officeId));

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
      // 0092 — resolve the office name so the InfoCard can render it
      // without a second round trip.
      const [office] = await deps.db
        .select({ name: offices.name })
        .from(offices)
        .where(eq(offices.id, client.officeId))
        .limit(1);
      res.json({ client: { ...client, officeName: office?.name ?? null } });
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
    // 0092 — resolve officeId. Caller-supplied wins; otherwise fall
    // back to the staff user's default office; otherwise the firm's
    // default office (is_default=true) or the earliest-created one.
    let officeId: string | undefined = parsed.data.officeId;
    if (!officeId) {
      const [me] = await deps.db
        .select({ defaultOfficeId: appUsers.defaultOfficeId })
        .from(appUsers)
        .where(eq(appUsers.id, session.appUserId))
        .limit(1);
      officeId = me?.defaultOfficeId ?? undefined;
    }
    if (!officeId) {
      const [firmOffice] = await deps.db
        .select({ id: offices.id })
        .from(offices)
        .where(eq(offices.firmId, firmId))
        .orderBy(desc(offices.isDefault), asc(offices.createdAt))
        .limit(1);
      officeId = firmOffice?.id;
    }
    if (!officeId) {
      res.status(400).json({ error: 'no_office_available_for_firm' });
      return;
    }
    // Validate the resolved office belongs to the firm.
    const [chosenOffice] = await deps.db
      .select({ id: offices.id })
      .from(offices)
      .where(and(eq(offices.id, officeId), eq(offices.firmId, firmId)))
      .limit(1);
    if (!chosenOffice) {
      res.status(400).json({ error: 'office_not_in_firm' });
      return;
    }
    const [row] = await deps.db
      .insert(clients)
      .values({ firmId, ...parsed.data, officeId })
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
      // 0092 — if officeId is being changed, validate it belongs to
      // this firm before letting the update through.
      if (parsed.data.officeId) {
        const [target] = await deps.db
          .select({ id: offices.id })
          .from(offices)
          .where(and(eq(offices.id, parsed.data.officeId), eq(offices.firmId, firmId)))
          .limit(1);
        if (!target) {
          res.status(400).json({ error: 'office_not_in_firm' });
          return;
        }
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
      // 0092 — resolve the firm's default office once for every imported
      // row. Bulk import doesn't expose a per-row office today; partners
      // can re-file from the client detail page after import.
      const bulkOfficeIdRaw = typeof req.body?.officeId === 'string' ? req.body.officeId : null;
      let bulkOfficeId: string | null = bulkOfficeIdRaw;
      if (!bulkOfficeId) {
        const [firmOffice] = await deps.db
          .select({ id: offices.id })
          .from(offices)
          .where(eq(offices.firmId, firmId))
          .orderBy(desc(offices.isDefault), asc(offices.createdAt))
          .limit(1);
        bulkOfficeId = firmOffice?.id ?? null;
      }
      if (!bulkOfficeId) {
        res.status(400).json({ error: 'no_office_available_for_firm' });
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
              officeId: bulkOfficeId,
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
            // 0115 — name/email/phone live on the firm-global person.
            const personId = await findOrCreatePerson(deps.db, {
              firmId,
              fullName: contactName,
              email,
              phone,
            });
            await deps.db.insert(clientContacts).values({
              clientId: newRow.id,
              personId,
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
          billingContactEmail: persons.email,
          billingContactPhone: persons.phone,
          termsDays: clients.termsDays,
          createdAt: clients.createdAt,
        })
        .from(clients)
        .leftJoin(
          clientContacts,
          and(eq(clientContacts.clientId, clients.id), eq(clientContacts.isBilling, true)),
        )
        .leftJoin(persons, eq(persons.id, clientContacts.personId))
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

  // Q36 — CSV client import (preview + commit).
  mountClientImportRoutes(router, deps);

  // v2 Sprint B — multi-contact CRUD endpoints (workstream 1.2).
  mountContactRoutes(router, deps);

  mountPeopleRoutes(router, deps);

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
  // FMv2 link routes — independent of Redis (the SSE stream falls
  // back to JSON when Redis isn't configured).
  mountFolderLinkRoutes(router, { db: deps.db, fakeUserRoles: deps.fakeUserRoles });
  mountCommunicationRoutes(router, deps);

  // v1 folder routes removed in Phase 0 of the file-manager rebuild.
  // Phase 4 (storage onboarding) introduces a new admin-scoped route
  // table; Phase 10 wires the per-client UI.

  // Connect I.4 — enroll / clear the client's tax_id for portal step-up.
  // Raw value never logged. Body is one of:
  //   { kind: 'ssn_last4' | 'ein', value: string }   — enrol / re-enrol
  //   { kind: 'clear' }                               — drop the hash
  router.put(
    '/:id/tax-id',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = TaxIdSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id, taxIdKind: clients.taxIdKind })
        .from(clients)
        .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const { isFeatureEnabled, normalizeTaxId, hashTaxId } = await import('../portal/tax-id');
      if (parsed.data.kind === 'clear') {
        await deps.db
          .update(clients)
          .set({ taxIdKind: null, taxIdHash: null })
          .where(eq(clients.id, client.id));
        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'client',
          entityId: client.id,
          actorAppUserId: session.appUserId,
          before: { taxIdKind: client.taxIdKind },
          after: { taxIdKind: null, cleared: true },
          ip: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.warn({ err }, 'audit emit failed'));
        res.json({ ok: true, kind: null });
        return;
      }
      if (!isFeatureEnabled()) {
        res.status(503).json({ error: 'tax_id_pepper_not_configured' });
        return;
      }
      const norm = normalizeTaxId(parsed.data.kind, parsed.data.value);
      if (!norm.ok) {
        res.status(400).json({ error: norm.error });
        return;
      }
      const hash = hashTaxId(parsed.data.kind, norm.digits);
      await deps.db
        .update(clients)
        .set({ taxIdKind: parsed.data.kind, taxIdHash: hash })
        .where(eq(clients.id, client.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client',
        entityId: client.id,
        actorAppUserId: session.appUserId,
        before: { taxIdKind: client.taxIdKind },
        // Never include the raw value — only the kind we enrolled.
        after: { taxIdKind: parsed.data.kind },
        ip: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.warn({ err }, 'audit emit failed'));
      res.json({ ok: true, kind: parsed.data.kind });
    },
  );

  // ----- bulk email --------------------------------------------------
  //
  // POST /api/staff/clients/bulk-email
  // Body: { clientIds: uuid[], subject, body }
  //
  // Resolves each client's primary-or-billing contact email (falls back
  // to any contact with an email when neither is flagged). Sends one
  // message per email via the staff mailer. Returns per-client outcomes.
  //
  // Permission: client:write (the action is firm-initiated outbound
  // communication; partners + managers gate this).
  const BulkEmailSchema = z.object({
    clientIds: z.array(z.string().uuid()).min(1).max(500),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
  });

  router.post(
    '/bulk-email',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = BulkEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!deps.sendStaffMail) {
        res.status(503).json({ error: 'mail_dispatch_not_configured' });
        return;
      }

      // Pull every targeted client + their contacts in two queries.
      const clientRows = await deps.db
        .select({ id: clients.id, name: clients.name })
        .from(clients)
        .where(and(eq(clients.firmId, session.firmId), inArray(clients.id, parsed.data.clientIds)));
      if (clientRows.length === 0) {
        res.status(404).json({ error: 'no_clients_found' });
        return;
      }
      const clientIds = clientRows.map((c) => c.id);
      const contactRows = await deps.db
        .select({
          clientId: clientContacts.clientId,
          fullName: persons.fullName,
          email: persons.email,
          isPrimary: clientContacts.isPrimary,
          isBilling: clientContacts.isBilling,
          status: clientContacts.status,
        })
        .from(clientContacts)
        .innerJoin(persons, eq(persons.id, clientContacts.personId))
        .where(inArray(clientContacts.clientId, clientIds));

      // Per-client: pick primary → billing → first-with-email; refuse
      // when none of those exist or none has an email.
      const byClient = new Map<string, typeof contactRows>();
      for (const c of contactRows) {
        if (c.status !== 'ACTIVE') continue;
        const arr = byClient.get(c.clientId) ?? [];
        arr.push(c);
        byClient.set(c.clientId, arr);
      }
      const results: Array<{
        clientId: string;
        clientName: string;
        sent: boolean;
        to: string | null;
        reason: string | null;
      }> = [];
      for (const client of clientRows) {
        const contacts = byClient.get(client.id) ?? [];
        const pick =
          contacts.find((c) => c.isPrimary && c.email) ||
          contacts.find((c) => c.isBilling && c.email) ||
          contacts.find((c) => c.email);
        if (!pick || !pick.email) {
          results.push({
            clientId: client.id,
            clientName: client.name,
            sent: false,
            to: null,
            reason: 'no_contact_with_email',
          });
          continue;
        }
        try {
          await deps.sendStaffMail({
            to: pick.email,
            subject: parsed.data.subject,
            body: parsed.data.body,
          });
          results.push({
            clientId: client.id,
            clientName: client.name,
            sent: true,
            to: pick.email,
            reason: null,
          });
        } catch (err) {
          results.push({
            clientId: client.id,
            clientName: client.name,
            sent: false,
            to: pick.email,
            reason: err instanceof Error ? err.message : 'send_failed',
          });
        }
      }

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client',
        // Anchor on the first targeted client; full id list lives in after.
        entityId: clientRows[0]!.id,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'bulk_email',
          clientIds,
          subject: parsed.data.subject,
          sentCount: results.filter((r) => r.sent).length,
          skippedCount: results.filter((r) => !r.sent).length,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'bulk-email audit failed'));

      res.json({
        results,
        summary: {
          requested: clientIds.length,
          sent: results.filter((r) => r.sent).length,
          skipped: results.filter((r) => !r.sent).length,
        },
      });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
