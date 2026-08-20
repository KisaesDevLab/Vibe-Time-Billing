// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client management (Phase 6).

import express, { type Request, type Response, type Router } from 'express';
import { csvField } from '../lib/csv';
import { z } from 'zod';
import { and, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientAccessGrants,
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
import { requirePermission, userHasPermission, type RbacDeps } from '../auth/rbac-middleware';
import {
  canAccessClient,
  getBlockedClientIdsCached,
  requireFullClientAccessForSection,
} from './access';
import { createClientCredentialRouter } from '../vault/routes';
import { firmScope } from '../notifications/templating';
import { resolveMergeTokens, type MergeContext } from '@vibe/core/proposals';
import { markdownToHtml } from '../lib/markdown';
import type { StorageAdapter } from '../files/storage';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { mountCommunicationRoutes } from './communications';
import { mountContactRoutes } from './contacts';
import { mountPeopleRoutes } from './people';
import { mountFileRoutes } from './files';
import { mountClientImportRoutes } from './import';
import { findOrCreatePerson } from './person-helpers';
import { printClientMailing, type MailingKind } from './mailing-print';
import {
  buildLetterContext,
  listLetterTemplates,
  loadAppointmentLetterData,
  loadClientLetterData,
  loadEngagementLetterData,
  loadLetterTemplateBody,
  renderLetterHtml,
  type ClientLetterData,
} from './letter-merge';
import { combineStatementsHtml } from '@vibe/core/invoicing';
import { buildStorageClient } from '@vibe/storage';
import { createFileInClientFolder } from './create-file';
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

// 0212 — client business-entity classification, mirrors the
// client_entity_type pgEnum.
const ENTITY_TYPES = [
  'SOLE_PROPRIETOR',
  'JOINT_VENTURE',
  'PARTNERSHIP_1065',
  'S_CORP_1120S',
  'C_CORP_1120',
  'EXEMPT_ORG_990',
  'TRUST_1041',
  'ESTATE_706',
  'GIFT_709',
  'OTHER',
] as const;

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
  // 0212 — business-side counterpart to filingStatus: which legal/tax
  // entity a BUSINESS client is.
  entityType: z.enum(ENTITY_TYPES).nullable().optional(),
  clientFacingName: z.string().max(200).nullable().optional(),
  externalId: z.string().max(120).nullable().optional(),
  // 0152 — second identifier for the Vibe Filer document mapper.
  awsId: z.string().max(120).nullable().optional(),
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

// 0165 — per-client visibility restriction payload.
const RestrictionSchema = z.object({
  restricted: z.boolean(),
  designatedUserIds: z.array(z.string().uuid()).max(200).default([]),
});

// Client `name` is unique within a firm among non-archived clients
// (case-insensitive, trimmed). Two genuinely-different clients that
// share a name are distinguished by editing the internal name; the
// client-facing name can still collide freely. Returns true when a
// conflicting client exists (optionally excluding one id, for rename).
async function nameTaken(
  db: Database,
  firmId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return false;
  const conds = [
    eq(clients.firmId, firmId),
    ne(clients.status, 'ARCHIVED'),
    sql`lower(btrim(${clients.name})) = ${needle}`,
  ];
  if (excludeId) conds.push(ne(clients.id, excludeId));
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(...conds))
    .limit(1);
  return Boolean(row);
}

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

  // 0165 — Layer-1 per-client restriction guard. Gates only the
  // RESTRICTED sub-routes under /:id/<section> (notes/tasks/files/folder/
  // communications/credentials); basic sections + the detail GET pass
  // through. Mounted before the credentials sub-router so it covers it too.
  router.use('/:id/:section', requireFullClientAccessForSection(deps));

  // 0159 — per-client credential vault (encrypted at rest; reveal gated by
  // step-up + audit). Mounted as a sub-router so :id resolves to the client.
  router.use(
    '/:id/credentials',
    createClientCredentialRouter({ db: deps.db, fakeUserRoles: deps.fakeUserRoles }),
  );

  router.get('/', requirePermission(deps, 'client:read'), async (req: Request, res: Response) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ items: [] });
      return;
    }
    const q = (req.query['q'] ?? '').toString().trim();
    // Filters accept a comma-separated set (multi-select column headers) or a
    // single value; both collapse to an IN(...) match.
    const csv = (v: unknown): string[] =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    const partnerId = typeof req.query['partnerId'] === 'string' ? req.query['partnerId'] : null;
    // 0050 — new filters
    const clientOwnerIds = csv(req.query['clientOwnerId']);
    const externalId = typeof req.query['externalId'] === 'string' ? req.query['externalId'] : null;
    const clientTypes = csv(req.query['clientType']).filter(
      (t) => t === 'INDIVIDUAL' || t === 'BUSINESS',
    );
    // 0212 — entity-type column filter.
    const entityTypes = csv(req.query['entityType']).filter((t) =>
      (ENTITY_TYPES as readonly string[]).includes(t),
    );
    const statuses = csv(req.query['status']).filter(
      (s) => s === 'ACTIVE' || s === 'ARCHIVED' || s === 'PROSPECT' || s === 'INACTIVE',
    );
    const officeIds = csv(req.query['officeId']);

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
    if (statuses.length > 0) conds.push(inArray(clients.status, statuses));
    if (partnerId) conds.push(eq(clients.partnerInChargeId, partnerId));
    if (clientOwnerIds.length > 0) conds.push(inArray(clients.partnerInChargeId, clientOwnerIds));
    if (externalId) conds.push(eq(clients.externalId, externalId));
    if (clientTypes.length > 0) conds.push(inArray(clients.clientType, clientTypes));
    if (entityTypes.length > 0)
      conds.push(inArray(clients.entityType, entityTypes as (typeof ENTITY_TYPES)[number][]));
    if (officeIds.length > 0) conds.push(inArray(clients.officeId, officeIds));

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
      entityType: sql`${clients.entityType}`,
      status: sql`${clients.status}`,
      createdAt: sql`${clients.createdAt}`,
      partnerName: sql`${appUsers.fullName}`,
      officeName: sql`${offices.name}`,
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
        entityType: clients.entityType,
        externalId: clients.externalId,
        awsId: clients.awsId,
        partnerInChargeId: clients.partnerInChargeId,
        partnerName: appUsers.fullName,
        officeId: clients.officeId,
        officeName: offices.name,
        termsDays: clients.termsDays,
        invoiceConsolidationPreference: clients.invoiceConsolidationPreference,
        createdAt: clients.createdAt,
        mailingCity: clients.mailingCity,
        mailingState: clients.mailingState,
        restricted: clients.restricted,
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

      // 0165 — restriction state for the caller. accessRestricted drives
      // the UI tab hiding (defense-in-depth; the sub-routes enforce too).
      const session = req.staffSession!;
      const accessRestricted =
        client.restricted && !(await canAccessClient(deps, session.appUserId, firmId, client.id));
      // Designated users are only exposed to callers who may manage the
      // restriction (admins + partners).
      let designatedUserIds: string[] | undefined;
      const canManageRestriction = await userHasPermission(
        deps,
        session.appUserId,
        'client:restrict:manage',
      );
      if (canManageRestriction) {
        const grants = await deps.db
          .select({ appUserId: clientAccessGrants.appUserId })
          .from(clientAccessGrants)
          .where(eq(clientAccessGrants.clientId, client.id));
        designatedUserIds = grants.map((g) => g.appUserId);
      }
      res.json({
        client: {
          ...client,
          officeName: office?.name ?? null,
          accessRestricted,
          canManageRestriction,
          ...(designatedUserIds ? { designatedUserIds } : {}),
        },
      });
    },
  );

  // ── Envelope / mailing-label direct print (Vibe Print gateway) ──────
  // Reuses the gateway's pre-formatted "#10 Envelope" / "Mailing Label
  // 4x3" templates; we only send the address data. Hidden in the UI when
  // the gateway is off (PrintButton). Read-grade action (addressing an
  // existing client), so gated on client:read like the other prints.
  const MailingPrintSchema = z.object({
    printerId: z.number().int().positive(),
    copies: z.number().int().min(1).max(20).optional(),
  });
  const mailingPrintHandler =
    (kind: MailingKind) =>
    async (req: Request, res: Response): Promise<void> => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = MailingPrintSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const result = await printClientMailing({
        db: deps.db,
        firmId: req.staffSession!.firmId,
        clientId: req.params['id']!,
        kind,
        printerId: parsed.data.printerId,
        copies: parsed.data.copies,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ ok: true, jobId: result.jobId });
    };
  router.post(
    '/:id/print-envelope',
    requirePermission(deps, 'client:read'),
    mailingPrintHandler('envelope'),
  );
  router.post(
    '/:id/print-label',
    requirePermission(deps, 'client:read'),
    mailingPrintHandler('label'),
  );

  // ── Mail merge: a firm letter template → personalized letters for many
  // clients. Phase 1 output = one combined PDF (a page-run per client).
  // Read-grade (generates a document from existing client data).
  router.get(
    '/mail-merge-templates',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await listLetterTemplates(deps.db, req.staffSession!.firmId);
      res.json({ items });
    },
  );

  // Resolve the per-letter rows for a merge run — one row per appointment
  // (Appointments flow), per engagement (Engagements flow — pulls the
  // engagement's drop-off date + its appointment in [apptFrom, apptTo]),
  // else one per client (Clients flow). Rows for RESTRICTED clients the
  // caller can't access (0165) are dropped, so no letter is rendered,
  // saved, or emailed for them.
  const resolveLetterRows = async (
    req: Request,
    firmId: string,
    appUserId: string,
    data: {
      clientIds?: string[];
      appointmentIds?: string[];
      engagementIds?: string[];
      apptFrom?: string;
      apptTo?: string;
    },
  ): Promise<ClientLetterData[]> => {
    let rows: ClientLetterData[];
    if (data.appointmentIds && data.appointmentIds.length > 0) {
      rows = await loadAppointmentLetterData(deps.db!, firmId, data.appointmentIds);
    } else if (data.engagementIds && data.engagementIds.length > 0) {
      rows = await loadEngagementLetterData(deps.db!, firmId, data.engagementIds, {
        from: data.apptFrom,
        to: data.apptTo,
      });
    } else {
      rows = await loadClientLetterData(deps.db!, firmId, data.clientIds ?? []);
    }
    const blocked = await getBlockedClientIdsCached(deps, req, appUserId, firmId);
    if (blocked.length === 0) return rows;
    const blockedSet = new Set(blocked);
    return rows.filter((r) => !blockedSet.has(r.id));
  };

  // Appointment/engagement flows expose that data — gate them behind the
  // corresponding read permission (a firm may revoke appointment:read /
  // engagement:read via the 0147 override while keeping client:read).
  const modePermitted = async (
    req: Request,
    res: Response,
    d: { appointmentIds?: string[]; engagementIds?: string[] },
  ): Promise<boolean> => {
    const appUserId = req.staffSession!.appUserId;
    if (
      d.appointmentIds?.length &&
      !(await userHasPermission(deps, appUserId, 'appointment:read'))
    ) {
      res.status(403).json({ error: 'forbidden', required: 'appointment:read' });
      return false;
    }
    if (d.engagementIds?.length && !(await userHasPermission(deps, appUserId, 'engagement:read'))) {
      res.status(403).json({ error: 'forbidden', required: 'engagement:read' });
      return false;
    }
    return true;
  };

  // Shared target fields for the pdf/save/email schemas — one of clientIds /
  // appointmentIds / engagementIds, plus an optional appointment date range
  // (engagements flow only). YMD must be a real calendar date (the regex
  // alone would accept 2026-13-40 → Invalid Date → 500 downstream).
  const isRealYmd = (s: string): boolean => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d!));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
  };
  const YMD = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealYmd, { message: 'invalid_date' });
  const targetFields = {
    clientIds: z.array(z.string().uuid()).max(200).optional(),
    appointmentIds: z.array(z.string().uuid()).max(200).optional(),
    engagementIds: z.array(z.string().uuid()).max(200).optional(),
    apptFrom: YMD.optional(),
    apptTo: YMD.optional(),
  };
  const hasTarget = (d: {
    clientIds?: string[];
    appointmentIds?: string[];
    engagementIds?: string[];
  }): boolean =>
    (d.clientIds?.length ?? 0) + (d.appointmentIds?.length ?? 0) + (d.engagementIds?.length ?? 0) >
    0;
  // from must not be after to (string compare is chronological for YMD).
  const rangeOk = (d: { apptFrom?: string; apptTo?: string }): boolean =>
    !d.apptFrom || !d.apptTo || d.apptFrom <= d.apptTo;

  const MailMergePreviewSchema = z
    .object({
      templateId: z.string().uuid(),
      clientId: z.string().uuid().optional(),
      appointmentId: z.string().uuid().optional(),
      engagementId: z.string().uuid().optional(),
      apptFrom: YMD.optional(),
      apptTo: YMD.optional(),
    })
    .refine((d) => Boolean(d.clientId) || Boolean(d.appointmentId) || Boolean(d.engagementId), {
      message: 'target_required',
    })
    .refine(rangeOk, { message: 'invalid_range' });
  router.post(
    '/mail-merge-preview',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = MailMergePreviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const target = {
        clientIds: parsed.data.clientId ? [parsed.data.clientId] : undefined,
        appointmentIds: parsed.data.appointmentId ? [parsed.data.appointmentId] : undefined,
        engagementIds: parsed.data.engagementId ? [parsed.data.engagementId] : undefined,
        apptFrom: parsed.data.apptFrom,
        apptTo: parsed.data.apptTo,
      };
      if (!(await modePermitted(req, res, target))) return;
      const firmId = req.staffSession!.firmId;
      const tpl = await loadLetterTemplateBody(deps.db, firmId, parsed.data.templateId);
      if (!tpl) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }
      const [client] = await resolveLetterRows(req, firmId, req.staffSession!.appUserId, target);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const firm = await firmScope(deps.db, firmId);
      res.json({ html: renderLetterHtml(tpl.bodyHtml, client, firm, new Date(), tpl.pageMargin) });
    },
  );

  const MailMergePdfSchema = z
    .object({ templateId: z.string().uuid(), ...targetFields })
    .refine(hasTarget, { message: 'targets_required' })
    .refine(rangeOk, { message: 'invalid_range' });
  router.post(
    '/mail-merge-pdf',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = MailMergePdfSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      if (!(await modePermitted(req, res, parsed.data))) return;
      const firmId = req.staffSession!.firmId;
      const tpl = await loadLetterTemplateBody(deps.db, firmId, parsed.data.templateId);
      if (!tpl) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }
      const clientData = await resolveLetterRows(
        req,
        firmId,
        req.staffSession!.appUserId,
        parsed.data,
      );
      if (clientData.length === 0) {
        res.status(404).json({ error: 'no_clients_found' });
        return;
      }
      const firm = await firmScope(deps.db, firmId);
      const now = new Date();
      const htmls = clientData.map((c) =>
        renderLetterHtml(tpl.bodyHtml, c, firm, now, tpl.pageMargin),
      );
      const combined = combineStatementsHtml(htmls);
      let pdf: Buffer;
      try {
        const { renderHtmlToPdf } = await import('../pdf/render');
        // Page margins come from the letter template's `@page { margin }`
        // rule (DEFAULT_LETTER_CSS = 1in), which Chromium honors.
        pdf = await renderHtmlToPdf(combined);
      } catch (err) {
        logger.error({ err }, 'mail-merge pdf render failed');
        res.status(502).json({ error: 'render_failed' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'EXPORT',
        entityType: 'client',
        entityId: clientData[0]!.id,
        actorAppUserId: req.staffSession!.appUserId,
        after: {
          kind: 'mail_merge_letter',
          templateId: parsed.data.templateId,
          clientIds: clientData.map((c) => c.id),
          count: clientData.length,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'mail-merge audit failed'));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="mail-merge-letters.pdf"');
      res.send(pdf);
    },
  );

  // Save one personalized letter PDF into each client's Files folder
  // (Correspondence/). Renders per row (own PDF, not the combined one).
  // Writes a `files` row per client via the shared create-file helper.
  // Mutating → client:write (+ appointment/engagement:read per mode).
  const MailMergeSaveSchema = z
    .object({ templateId: z.string().uuid(), ...targetFields })
    .refine(hasTarget, { message: 'targets_required' })
    .refine(rangeOk, { message: 'invalid_range' });
  router.post(
    '/mail-merge-save-to-files',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = MailMergeSaveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      if (!(await modePermitted(req, res, parsed.data))) return;
      const session = req.staffSession!;
      const firmId = session.firmId;
      const tpl = await loadLetterTemplateBody(deps.db, firmId, parsed.data.templateId);
      if (!tpl) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }
      const clientData = await resolveLetterRows(req, firmId, session.appUserId, parsed.data);
      if (clientData.length === 0) {
        res.status(404).json({ error: 'no_clients_found' });
        return;
      }
      let renderMod;
      try {
        renderMod = await import('../pdf/render');
      } catch (err) {
        logger.error({ err }, 'mail-merge save render import failed');
        res.status(502).json({ error: 'render_failed' });
        return;
      }
      const { renderHtmlToPdf } = renderMod;
      const storage = buildStorageClient(process.env);
      const firm = await firmScope(deps.db, firmId);
      const now = new Date();
      const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}`;
      const results: Array<{
        clientId: string;
        clientName: string;
        saved: boolean;
        reason: string | null;
      }> = [];
      for (const client of clientData) {
        try {
          const pdf = await renderHtmlToPdf(
            renderLetterHtml(tpl.bodyHtml, client, firm, now, tpl.pageMargin),
          );
          const out = await createFileInClientFolder(deps.db, storage, {
            firmId,
            clientId: client.id,
            actorId: session.appUserId,
            category: 'correspondence',
            originalFilename: `${tpl.name} - ${stamp}.pdf`,
            body: pdf,
            mimeType: 'application/pdf',
            source: 'mail_merge',
          });
          results.push({
            clientId: client.id,
            clientName: client.name,
            saved: out.ok,
            reason: out.ok ? null : out.code,
          });
        } catch (err) {
          results.push({
            clientId: client.id,
            clientName: client.name,
            saved: false,
            reason: err instanceof Error ? err.message : 'render_failed',
          });
        }
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client',
        entityId: clientData[0]!.id,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'mail_merge_save_to_files',
          templateId: parsed.data.templateId,
          clientIds: results.filter((r) => r.saved).map((r) => r.clientId),
          savedCount: results.filter((r) => r.saved).length,
          skippedCount: results.filter((r) => !r.saved).length,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'mail-merge save audit failed'));
      res.json({
        results,
        summary: {
          requested: clientData.length,
          saved: results.filter((r) => r.saved).length,
          skipped: results.filter((r) => !r.saved).length,
        },
      });
    },
  );

  // Email each client their letter as a PDF attachment. Per client:
  // resolve recipient (primary→billing→first with an email) → render the
  // letter → attach the PDF → sendStaffMail. Subject/body are merge-token
  // resolved per client. Outbound → client:write (+ appointment/engagement:read
  // per mode).
  const MailMergeEmailSchema = z
    .object({
      templateId: z.string().uuid(),
      ...targetFields,
      subject: z.string().min(1).max(200),
      body: z.string().max(20_000).optional(),
    })
    .refine(hasTarget, { message: 'targets_required' })
    .refine(rangeOk, { message: 'invalid_range' });
  router.post(
    '/mail-merge-email',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!deps.sendStaffMail) {
        res.status(503).json({ error: 'mailer_unavailable' });
        return;
      }
      const sendStaffMail = deps.sendStaffMail;
      const parsed = MailMergeEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      if (!(await modePermitted(req, res, parsed.data))) return;
      const session = req.staffSession!;
      const firmId = session.firmId;
      const tpl = await loadLetterTemplateBody(deps.db, firmId, parsed.data.templateId);
      if (!tpl) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }
      const clientData = await resolveLetterRows(req, firmId, session.appUserId, parsed.data);
      if (clientData.length === 0) {
        res.status(404).json({ error: 'no_clients_found' });
        return;
      }
      let renderMod;
      try {
        renderMod = await import('../pdf/render');
      } catch (err) {
        logger.error({ err }, 'mail-merge email render import failed');
        res.status(502).json({ error: 'render_failed' });
        return;
      }
      const { renderHtmlToPdf } = renderMod;
      const firm = await firmScope(deps.db, firmId);
      const now = new Date();
      const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}`;
      const results: Array<{
        clientId: string;
        clientName: string;
        sent: boolean;
        to: string | null;
        reason: string | null;
      }> = [];
      for (const client of clientData) {
        if (!client.recipientEmail) {
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
          const ctx = buildLetterContext(client, firm, now) as MergeContext;
          // Strip CR/LF so a token value can't inject email headers.
          const subject = resolveMergeTokens(parsed.data.subject, ctx)
            .output.replace(/[\r\n]+/g, ' ')
            .trim();
          const bodyText = resolveMergeTokens(
            parsed.data.body?.trim() || 'Please see the attached letter.',
            ctx,
          ).output;
          const pdf = await renderHtmlToPdf(
            renderLetterHtml(tpl.bodyHtml, client, firm, now, tpl.pageMargin),
          );
          await sendStaffMail({
            to: client.recipientEmail,
            subject,
            body: bodyText,
            html: markdownToHtml(bodyText),
            attachments: [
              {
                filename: `${tpl.name} - ${stamp}.pdf`,
                content: pdf,
                contentType: 'application/pdf',
              },
            ],
          });
          results.push({
            clientId: client.id,
            clientName: client.name,
            sent: true,
            to: client.recipientEmail,
            reason: null,
          });
        } catch (err) {
          results.push({
            clientId: client.id,
            clientName: client.name,
            sent: false,
            to: client.recipientEmail,
            reason: err instanceof Error ? err.message : 'send_failed',
          });
        }
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client',
        entityId: clientData[0]!.id,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'mail_merge_email',
          templateId: parsed.data.templateId,
          subject: parsed.data.subject,
          clientIds: results.filter((r) => r.sent).map((r) => r.clientId),
          sentCount: results.filter((r) => r.sent).length,
          skippedCount: results.filter((r) => !r.sent).length,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'mail-merge email audit failed'));
      res.json({
        results,
        summary: {
          requested: clientData.length,
          sent: results.filter((r) => r.sent).length,
          skipped: results.filter((r) => !r.sent).length,
        },
      });
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
    // Reject a duplicate name up front (case-insensitive, non-archived).
    if (await nameTaken(deps.db, firmId, parsed.data.name)) {
      res.status(409).json({ error: 'duplicate_name' });
      return;
    }
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
      .values({
        firmId,
        ...parsed.data,
        name: parsed.data.name.trim(),
        // Blank client-facing name defaults to the client name — portal,
        // letters, and labels render it directly, so a NULL here leaks an
        // empty display name anywhere the read-time fallback was missed.
        clientFacingName: parsed.data.clientFacingName?.trim() || parsed.data.name.trim(),
        officeId,
      })
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
      // Block a rename into another (non-archived) client's name.
      if (
        parsed.data.name !== undefined &&
        (await nameTaken(deps.db, firmId, parsed.data.name, req.params['id']!))
      ) {
        res.status(409).json({ error: 'duplicate_name' });
        return;
      }
      const patch: Record<string, unknown> = { ...parsed.data };
      if (parsed.data.name !== undefined) patch['name'] = parsed.data.name.trim();
      // Blanking the client-facing name normalizes it back to the client
      // name (mirrors the create default) instead of storing ''/NULL.
      if (parsed.data.clientFacingName !== undefined && !parsed.data.clientFacingName?.trim()) {
        let fallback = parsed.data.name?.trim();
        if (!fallback) {
          const [cur] = await deps.db
            .select({ name: clients.name })
            .from(clients)
            .where(and(eq(clients.firmId, firmId), eq(clients.id, req.params['id']!)))
            .limit(1);
          fallback = cur?.name;
        }
        if (fallback) patch['clientFacingName'] = fallback;
      }
      await deps.db
        .update(clients)
        .set(patch)
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

  // 0165 — per-client visibility restriction. Admin + partner only
  // (client:restrict:manage). Sets the restricted flag and replaces the
  // designated-user grant set in one transaction. Kept off the generic
  // client:write PATCH so managers can't change restriction.
  router.put(
    '/:id/restriction',
    requirePermission(deps, 'client:restrict:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const firmId = session.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const parsed = RestrictionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const clientId = req.params['id']!;
      const [client] = await deps.db
        .select({ id: clients.id, restricted: clients.restricted })
        .from(clients)
        .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Validate the designated users belong to this firm (ignore unknown
      // / cross-firm ids rather than 400 — keeps the UI resilient).
      const requested = Array.from(new Set(parsed.data.designatedUserIds));
      const validUsers = requested.length
        ? await deps.db
            .select({ id: appUsers.id })
            .from(appUsers)
            .where(and(eq(appUsers.firmId, firmId), inArray(appUsers.id, requested)))
        : [];
      const validUserIds = validUsers.map((u) => u.id);

      const before = await deps.db
        .select({ appUserId: clientAccessGrants.appUserId })
        .from(clientAccessGrants)
        .where(eq(clientAccessGrants.clientId, clientId));

      await deps.db.transaction(async (tx) => {
        await tx
          .update(clients)
          .set({ restricted: parsed.data.restricted })
          .where(eq(clients.id, clientId));
        await tx.delete(clientAccessGrants).where(eq(clientAccessGrants.clientId, clientId));
        if (validUserIds.length) {
          await tx.insert(clientAccessGrants).values(
            validUserIds.map((appUserId) => ({
              clientId,
              appUserId,
              grantedById: session.appUserId,
            })),
          );
        }
      });

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client',
        entityId: clientId,
        actorAppUserId: session.appUserId,
        before: {
          restricted: client.restricted,
          designatedUserIds: before.map((b) => b.appUserId),
        },
        after: { restricted: parsed.data.restricted, designatedUserIds: validUserIds },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.json({ ok: true, restricted: parsed.data.restricted, designatedUserIds: validUserIds });
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
      // 0208 — the internal admin client is permanent.
      if (await ownsFirmAdminEngagement(deps.db, req.params['id']!)) {
        res.status(409).json({ error: 'firm_admin_client' });
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
  // 0208 — the internal client that owns the firm-administrative
  // engagement can never be archived (or merged away): admin time must
  // always have a home.
  async function ownsFirmAdminEngagement(db: Database, clientId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(and(eq(engagements.clientId, clientId), eq(engagements.firmAdmin, true)))
      .limit(1);
    return !!row;
  }

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
      // Merge archives the source — the internal admin client can't be one.
      if (await ownsFirmAdminEngagement(deps.db, sourceId)) {
        res.status(409).json({ error: 'firm_admin_client' });
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
      // 0208 — bulk archive silently skips the internal admin client.
      let effectiveIds = ids;
      if (status === 'ARCHIVED') {
        const protectedRows = await deps.db
          .select({ clientId: engagements.clientId })
          .from(engagements)
          .where(and(inArray(engagements.clientId, ids), eq(engagements.firmAdmin, true)));
        const protectedIds = new Set(protectedRows.map((r) => r.clientId));
        effectiveIds = ids.filter((id) => !protectedIds.has(id));
        if (effectiveIds.length === 0) {
          res.json({ updated: 0 });
          return;
        }
      }
      const updated = await deps.db
        .update(clients)
        .set({ status })
        .where(and(eq(clients.firmId, session.firmId), inArray(clients.id, effectiveIds)))
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

      // Pull every targeted client + their contacts in two queries. Drop
      // RESTRICTED clients the caller can't access (0165).
      const blockedBulk = new Set(
        await getBlockedClientIdsCached(deps, req, session.appUserId, session.firmId),
      );
      const clientRows = (
        await deps.db
          .select({ id: clients.id, name: clients.name })
          .from(clients)
          .where(
            and(eq(clients.firmId, session.firmId), inArray(clients.id, parsed.data.clientIds)),
          )
      ).filter((c) => !blockedBulk.has(c.id));
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
      // Firm-level merge tokens (firm.name, firm.support_email, …) — fetched
      // once and reused for every recipient.
      const firmTokens = await firmScope(deps.db, session.firmId);
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
          // Substitute {{client.*}} / {{firm.*}} per recipient, then render the
          // Markdown body to HTML (the staff mailer wraps it in the firm's
          // branded shell). The substituted Markdown doubles as the text part.
          const ctx: MergeContext = {
            firm: firmTokens,
            client: { name: client.name, primaryContact: pick.fullName ?? '' },
          };
          const subject = resolveMergeTokens(parsed.data.subject, ctx)
            .output.replace(/[\r\n]+/g, ' ')
            .trim();
          const textBody = resolveMergeTokens(parsed.data.body, ctx).output;
          await deps.sendStaffMail({
            to: pick.email,
            subject,
            body: textBody,
            html: markdownToHtml(textBody),
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
  return csvField(s);
}
