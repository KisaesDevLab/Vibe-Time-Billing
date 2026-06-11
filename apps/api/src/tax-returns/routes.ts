// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-3 — Staff tax-return release API.
//
// POST   /api/staff/tax/returns/:returnId/releases    create a release
// DELETE /api/staff/tax/returns/:returnId/releases/:releaseId  revoke
//
// Permissions:
//   • engagement:read = list + read
//   • engagement:write = create release
//   • engagement:write = revoke release
//
// The plan calls for partner/manager separation (manager marks for
// review, partner approves). v1 collapses both into `engagement:write`
// — RBAC is already permission-keyed and the role→permission map can
// add a finer-grained `tax:release` permission later.

import express, { type Request, type Response, type Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientPortalAccess,
  clients,
  files,
  portalIdentity,
  taxReturnReleases,
  taxReturnSections,
  taxReturns,
  taxReturnShares,
} from '@vibe/db/schema';
import { and, inArray, isNull } from 'drizzle-orm';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { createRelease, revokeRelease, ReleaseError } from './release-helper';
import { appendAccessLog, exportAccessLogCsv, listAccessLog } from './access-log';
import { AmendError, computeAmendDiff, createAmendedReturn, markOriginalSuperseded } from './amend';
import { applyParsedSections, parseReturnSections } from './parse';
import { intakeTaxReturnFromFile } from './intake';
import {
  createSignaturePackageFromReturn,
  detectSignaturePagesForReturn,
} from './signature-package';
import { randomUUID } from 'node:crypto';

export interface TaxReturnRoutesDeps extends RbacDeps {
  db: Database | null;
  // Object storage for the automated section parser (reads the source
  // PDF). Tests inject a fake here; in production we resolve it lazily
  // per request so it picks up the B2 creds folded into process.env at
  // boot (the env hydration completes after the server starts, so a
  // client built at construction time would be the dev mock).
  storage?: StorageClient | null;
}

function resolveStorage(deps: TaxReturnRoutesDeps): StorageClient | null {
  if (deps.storage) return deps.storage;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

// Manual section create — staff builds/corrects a section by page range.
const CreateSectionSchema = z
  .object({
    normalizedTitle: z.string().min(1).max(200),
    kind: z
      .enum(['COVER', 'MAIN_FORM', 'SCHEDULE', 'K1', 'STATE', 'WORKSHEET', 'ATTACHMENT', 'UNKNOWN'])
      .default('UNKNOWN'),
    formCode: z.string().max(40).nullable().default(null),
    recipientName: z.string().max(120).nullable().default(null),
    startPage: z.number().int().positive(),
    endPage: z.number().int().positive(),
    releasable: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.endPage >= v.startPage, { message: 'end_before_start' });

const SignaturePackageSchema = z.object({
  signers: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        email: z.string().email(),
        role: z.string().min(1).max(40),
        personId: z.string().uuid().nullable().optional(),
        clientContactId: z.string().uuid().nullable().optional(),
        portalIdentityId: z.string().uuid().nullable().optional(),
      }),
    )
    .min(1),
  returnPages: z
    .array(
      z.object({
        page: z.number().int().positive(),
        layoutKey: z.string().min(1).max(40),
        profileFormType: z.string().min(1).max(40).nullable().optional(),
      }),
    )
    .default([]),
  templateIds: z.array(z.string().uuid()).default([]),
  adHocKeys: z.array(z.string().min(1).max(400)).default([]),
});

const CreateReleaseSchema = z.object({
  releasedToClientId: z.string().uuid(),
  scope: z.enum(['FULL', 'SELECTED']),
  sectionIds: z.array(z.string().uuid()).default([]),
  clientCanDownload: z.boolean().default(true),
  coverNote: z.string().max(2000).nullable().default(null),
});

const CreateAmendSchema = z.object({
  newTitle: z.string().min(1).max(200),
  newSourceFileId: z.string().uuid().nullable().default(null),
  newSourceFileSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .nullable()
    .default(null),
  newTotalPages: z.number().int().positive().nullable().default(null),
});

// Section PATCH — staff edits to a parsed section. Setting any field
// flips is_manual_override = true so a future re-parse refuses to
// clobber the edit. All fields optional; only the supplied subset is
// updated.
const PatchSectionSchema = z
  .object({
    normalizedTitle: z.string().min(1).max(200).optional(),
    kind: z
      .enum(['COVER', 'MAIN_FORM', 'SCHEDULE', 'K1', 'STATE', 'WORKSHEET', 'ATTACHMENT', 'UNKNOWN'])
      .optional(),
    formCode: z.string().max(40).nullable().optional(),
    recipientName: z.string().max(120).nullable().optional(),
    releasable: z.boolean().optional(),
    startPage: z.number().int().positive().optional(),
    endPage: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'no_fields_to_update' })
  .refine((v) => v.startPage === undefined || v.endPage === undefined || v.endPage >= v.startPage, {
    message: 'end_before_start',
  });

export function createTaxReturnRouter(deps: TaxReturnRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['returnId', 'releaseId', 'sectionId']);

  // -------------------------------------------------------------------
  // Manual intake — flag a file in the client's Files folder as a tax
  // return. Creates a DRAFT tax_returns row pointing at the file plus a
  // single catch-all section so the release flow (which scopes byte
  // ranges by section) has something to work with. Full automated
  // parsing (Drake/Lacerte/UltraTax exports, multi-section detection,
  // per-recipient K-1 splits, etc.) is a separate scope; this gets a
  // real return into the system today.
  //
  // Permission: engagement:write (same gate as release/amend — flagging
  // a tax return is a partner/manager action).
  // -------------------------------------------------------------------
  const IntakeFromFileSchema = z.object({
    fileId: z.string().uuid(),
    taxYear: z.number().int().min(1900).max(2999),
    formCode: z.string().min(1).max(40),
    jurisdiction: z.string().min(1).max(40).default('federal'),
    title: z.string().min(1).max(200).optional(),
    engagementId: z.string().uuid().nullable().optional(),
    totalPages: z.number().int().positive().nullable().optional(),
  });

  router.post(
    '/intake-from-file',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = IntakeFromFileSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
        return;
      }
      const result = await intakeTaxReturnFromFile(deps.db, resolveStorage(deps), {
        firmId: session.firmId,
        fileId: parsed.data.fileId,
        taxYear: parsed.data.taxYear,
        formCode: parsed.data.formCode,
        jurisdiction: parsed.data.jurisdiction,
        title: parsed.data.title,
        engagementId: parsed.data.engagementId ?? null,
        totalPages: parsed.data.totalPages ?? null,
        actorId: session.appUserId,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      if (!result.ok) {
        if (result.code === 'already_flagged') {
          res.status(409).json({ error: 'file_already_flagged', taxReturnId: result.taxReturnId });
        } else if (result.code === 'file_pending_upload') {
          res.status(409).json({ error: 'file_pending_upload' });
        } else {
          res.status(404).json({ error: 'file_not_found' });
        }
        return;
      }
      res.status(201).json({ taxReturnId: result.taxReturnId });
    },
  );

  // -------------------------------------------------------------------
  // Delete a tax return (undo a flag / remove a mis-imported return).
  //
  // Hard delete. Child sections/releases/shares/access-log all cascade
  // (FK onDelete: cascade), and the source `files` row is untouched (the
  // tax return only *references* it), so the file stays in the client's
  // Files folder and can be re-flagged. Deleting a RELEASED return is
  // allowed — the cascade removes the release rows, so the client
  // immediately loses portal access (the viewer 404s) and any active
  // share links stop resolving; that's the intended "retract" behavior.
  // The deletion (incl. prior status) is captured in the immutable audit
  // log. The only block left is an open amendment that points at this
  // return (would orphan the amends_return_id chain) — delete that first.
  //
  // Permission: engagement:write (same gate as intake/release/amend).
  // -------------------------------------------------------------------
  router.delete(
    '/:returnId',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const returnId = req.params['returnId']!;
      const [ret] = await deps.db
        .select({
          id: taxReturns.id,
          firmId: taxReturns.firmId,
          clientId: taxReturns.clientId,
          taxYear: taxReturns.taxYear,
          formCode: taxReturns.formCode,
          jurisdiction: taxReturns.jurisdiction,
          title: taxReturns.title,
          status: taxReturns.status,
          releaseKind: taxReturns.releaseKind,
          sourceFileId: taxReturns.sourceFileId,
        })
        .from(taxReturns)
        .where(and(eq(taxReturns.id, returnId), eq(taxReturns.firmId, session.firmId)))
        .limit(1);
      if (!ret) {
        res.status(404).json({ error: 'tax_return_not_found' });
        return;
      }
      const [amendment] = await deps.db
        .select({ id: taxReturns.id })
        .from(taxReturns)
        .where(and(eq(taxReturns.amendsReturnId, returnId), eq(taxReturns.firmId, session.firmId)))
        .limit(1);
      if (amendment) {
        res.status(409).json({
          error: 'has_amendments',
          detail: 'This return has an amendment that points at it. Delete the amendment first.',
        });
        return;
      }

      // Destructive op that can retract a RELEASED return from clients —
      // the audit row is non-negotiable (CLAUDE.md invariant #1). Emit
      // the audit and the cascade delete in ONE transaction so an audit
      // failure rolls the delete back rather than leaving a deleted
      // return with no trail. Audit first (entity still present), then
      // the cascade removes sections, releases, shares, access-log rows.
      await deps.db.transaction(async (tx) => {
        await emitAudit(tx as Database, {
          // ARCHIVE is the audit vocabulary's removal verb (no DELETE).
          action: 'ARCHIVE',
          entityType: 'tax_return',
          entityId: returnId,
          actorAppUserId: session.appUserId,
          before: {
            clientId: ret.clientId,
            taxYear: ret.taxYear,
            formCode: ret.formCode,
            jurisdiction: ret.jurisdiction,
            title: ret.title,
            status: ret.status,
            releaseKind: ret.releaseKind,
            sourceFileId: ret.sourceFileId,
          },
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        });
        await tx
          .delete(taxReturns)
          .where(and(eq(taxReturns.id, returnId), eq(taxReturns.firmId, session.firmId)));
      });

      res.status(204).end();
    },
  );

  router.post(
    '/:returnId/releases',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = CreateReleaseSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
        return;
      }
      try {
        const result = await createRelease({
          db: deps.db,
          returnId: req.params['returnId']!,
          firmId: session.firmId,
          releasedToClientId: parsed.data.releasedToClientId,
          scope: parsed.data.scope,
          sectionIds: parsed.data.sectionIds,
          clientCanDownload: parsed.data.clientCanDownload,
          coverNote: parsed.data.coverNote,
          releasedByUserId: session.appUserId,
        });
        // TR-8 — audit. Best-effort; failure does not block the
        // release (which is already committed).
        await appendAccessLog({
          db: deps.db,
          returnId: req.params['returnId']!,
          event: 'RELEASED',
          actorKind: 'STAFF',
          actorRef: session.appUserId,
          actorIp: req.ip ?? null,
          actorUserAgent: req.get('user-agent') ?? null,
          metadata: {
            releaseId: result.releaseId,
            supersededReleaseId: result.supersededReleaseId,
            scope: parsed.data.scope,
          },
        }).catch(() => undefined);
        res.status(201).json(result);
      } catch (err) {
        if (err instanceof ReleaseError) {
          const status =
            err.code === 'forbidden' ? 403 : err.code.includes('not_found') ? 404 : 400;
          res.status(status).json({ error: err.code, detail: err.message });
          return;
        }
        throw err;
      }
    },
  );

  router.delete(
    '/:returnId/releases/:releaseId',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      try {
        await revokeRelease(deps.db, req.params['releaseId']!, session.appUserId, session.firmId);
        await appendAccessLog({
          db: deps.db,
          returnId: req.params['returnId']!,
          event: 'REVOKED',
          actorKind: 'STAFF',
          actorRef: session.appUserId,
          actorIp: req.ip ?? null,
          actorUserAgent: req.get('user-agent') ?? null,
          metadata: { releaseId: req.params['releaseId']! },
        }).catch(() => undefined);
        res.status(204).end();
      } catch (err) {
        if (err instanceof ReleaseError) {
          const status = err.code === 'forbidden' ? 403 : 404;
          res.status(status).json({ error: err.code, detail: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // Toggle whether the client can download a release's PDF (vs view-only).
  router.patch(
    '/:returnId/releases/:releaseId',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = z.object({ clientCanDownload: z.boolean() }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      // Scope-guard via the parent return.
      const [ret] = await deps.db
        .select({ id: taxReturns.id })
        .from(taxReturns)
        .where(
          and(eq(taxReturns.id, req.params['returnId']!), eq(taxReturns.firmId, session.firmId)),
        )
        .limit(1);
      if (!ret) {
        res.status(404).json({ error: 'return_not_found' });
        return;
      }
      const updated = await deps.db
        .update(taxReturnReleases)
        .set({ clientCanDownload: parsed.data.clientCanDownload })
        .where(
          and(
            eq(taxReturnReleases.id, req.params['releaseId']!),
            eq(taxReturnReleases.returnId, ret.id),
            isNull(taxReturnReleases.revokedAt),
          ),
        )
        .returning({ id: taxReturnReleases.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'release_not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'tax_return_release',
        entityId: req.params['releaseId']!,
        actorAppUserId: session.appUserId,
        after: { clientCanDownload: parsed.data.clientCanDownload },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true, clientCanDownload: parsed.data.clientCanDownload });
    },
  );

  // TR-10 — amendment chain.
  //
  // POST   /:returnId/amend                — clone original into a new
  //                                          AMENDED row in DRAFT state
  // POST   /:returnId/amend/approve        — flip the predecessor to
  //                                          SUPERSEDED (called when
  //                                          firm has decided the
  //                                          amended return supersedes
  //                                          the original)
  // GET    /:returnId/amend/diff           — section-presence diff
  //                                          vs the predecessor
  router.post(
    '/:returnId/amend',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = CreateAmendSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
        return;
      }
      try {
        const result = await createAmendedReturn({
          db: deps.db,
          originalReturnId: req.params['returnId']!,
          firmId: session.firmId,
          staffUserId: session.appUserId,
          newTitle: parsed.data.newTitle,
          newSourceFileId: parsed.data.newSourceFileId,
          newSourceFileSha256: parsed.data.newSourceFileSha256,
          newTotalPages: parsed.data.newTotalPages,
        });
        res.status(201).json(result);
      } catch (err) {
        if (err instanceof AmendError) {
          const status =
            err.code === 'forbidden'
              ? 403
              : err.code === 'original_not_found' || err.code === 'not_found'
                ? 404
                : 400;
          res.status(status).json({ error: err.code, detail: err.message });
          return;
        }
        throw err;
      }
    },
  );

  router.post(
    '/:returnId/amend/approve',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      try {
        const result = await markOriginalSuperseded(
          deps.db,
          req.params['returnId']!,
          session.firmId,
          session.appUserId,
        );
        if (result == null) {
          res.status(409).json({ error: 'not_an_amendment' });
          return;
        }
        res.json({ supersededId: result.supersededId });
      } catch (err) {
        if (err instanceof AmendError) {
          const status = err.code === 'forbidden' ? 403 : 404;
          res.status(status).json({ error: err.code, detail: err.message });
          return;
        }
        throw err;
      }
    },
  );

  router.get(
    '/:returnId/amend/diff',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const diff = await computeAmendDiff(deps.db, req.params['returnId']!, session.firmId);
      if (!diff) {
        res.status(404).json({ error: 'not_an_amendment' });
        return;
      }
      res.json(diff);
    },
  );

  // TR-8 — staff access-log read endpoints.
  router.get(
    '/:returnId/access-log',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const cursorRaw = req.query['cursor'];
      let cursor: { at: string; id: string } | null = null;
      if (typeof cursorRaw === 'string' && cursorRaw.length > 0) {
        try {
          cursor = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8'));
        } catch {
          res.status(400).json({ error: 'bad_cursor' });
          return;
        }
      }
      const result = await listAccessLog({
        db: deps.db,
        returnId: req.params['returnId']!,
        firmId: session.firmId,
        cursor,
        pageSize: 50,
        clientVisibleOnly: false,
      });
      const nextCursor =
        result.nextCursor === null
          ? null
          : Buffer.from(JSON.stringify(result.nextCursor)).toString('base64url');

      // Resolve each event's actor to a human name: STAFF → app user,
      // CLIENT → portal identity (+ which client they were acting for),
      // RECIPIENT → 3rd-party share recipient.
      const staffIds = new Set<string>();
      const accessIds = new Set<string>();
      const shareIds = new Set<string>();
      for (const it of result.items) {
        if (!it.actorRef) continue;
        if (it.actorKind === 'STAFF') staffIds.add(it.actorRef);
        else if (it.actorKind === 'CLIENT') accessIds.add(it.actorRef);
        else if (it.actorKind === 'RECIPIENT') shareIds.add(it.actorRef);
      }
      const staffNames = new Map<string, string>();
      if (staffIds.size > 0) {
        const rows = await deps.db
          .select({ id: appUsers.id, name: appUsers.fullName })
          .from(appUsers)
          .where(inArray(appUsers.id, [...staffIds]));
        for (const r of rows) staffNames.set(r.id, r.name);
      }
      // A CLIENT actor_ref is either a portal_identity id (VIEW events)
      // or a client_portal_access id (share events) — resolve both.
      const clientActorNames = new Map<string, string>();
      if (accessIds.size > 0) {
        const refs = [...accessIds];
        const identRows = await deps.db
          .select({
            id: portalIdentity.id,
            name: portalIdentity.fullName,
            email: portalIdentity.primaryEmail,
          })
          .from(portalIdentity)
          .where(inArray(portalIdentity.id, refs));
        for (const r of identRows) clientActorNames.set(r.id, r.name || r.email || 'Client user');
        const accessRows = await deps.db
          .select({
            accessId: clientPortalAccess.id,
            identityName: portalIdentity.fullName,
            identityEmail: portalIdentity.primaryEmail,
            clientName: clients.name,
          })
          .from(clientPortalAccess)
          .leftJoin(portalIdentity, eq(portalIdentity.id, clientPortalAccess.portalIdentityId))
          .leftJoin(clients, eq(clients.id, clientPortalAccess.clientId))
          .where(inArray(clientPortalAccess.id, refs));
        for (const r of accessRows) {
          const who = r.identityName || r.identityEmail || 'Client user';
          clientActorNames.set(r.accessId, r.clientName ? `${who} — ${r.clientName}` : who);
        }
      }
      const recipientNames = new Map<string, string>();
      if (shareIds.size > 0) {
        const rows = await deps.db
          .select({
            id: taxReturnShares.id,
            name: taxReturnShares.recipientName,
            email: taxReturnShares.recipientEmail,
            org: taxReturnShares.organization,
          })
          .from(taxReturnShares)
          .where(inArray(taxReturnShares.id, [...shareIds]));
        for (const r of rows)
          recipientNames.set(r.id, r.org ? `${r.name} (${r.org})` : `${r.name} · ${r.email}`);
      }
      const items = result.items.map((it) => {
        let actorName: string | null = null;
        if (it.actorKind === 'SYSTEM') actorName = 'System';
        else if (it.actorRef) {
          actorName =
            it.actorKind === 'STAFF'
              ? (staffNames.get(it.actorRef) ?? null)
              : it.actorKind === 'CLIENT'
                ? (clientActorNames.get(it.actorRef) ?? null)
                : it.actorKind === 'RECIPIENT'
                  ? (recipientNames.get(it.actorRef) ?? null)
                  : null;
        }
        return { ...it, actorName };
      });
      res.json({ items, nextCursor });
    },
  );

  router.get(
    '/:returnId/access-log.csv',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const csv = await exportAccessLogCsv({
        db: deps.db,
        returnId: req.params['returnId']!,
        firmId: session.firmId,
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="tax-return-access-log-${req.params['returnId']}.csv"`,
      );
      res.send(csv);
    },
  );

  // Helpful list for the staff UI: every return + latest live release
  // per client. Read-only; permission is engagement:read. Optional
  // ?clientId= filter scopes the list to a single client — used by
  // the client-dashboard Tax tab.
  router.get(
    '/',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const clientId = typeof req.query['clientId'] === 'string' ? req.query['clientId'] : null;
      const conds = [eq(taxReturns.firmId, session.firmId)];
      if (clientId) conds.push(eq(taxReturns.clientId, clientId));
      const rows = await deps.db
        .select({
          id: taxReturns.id,
          clientId: taxReturns.clientId,
          clientName: clients.name,
          taxYear: taxReturns.taxYear,
          formCode: taxReturns.formCode,
          jurisdiction: taxReturns.jurisdiction,
          title: taxReturns.title,
          status: taxReturns.status,
          releaseKind: taxReturns.releaseKind,
          totalPages: taxReturns.totalPages,
          releasedAt: taxReturns.releasedAt,
          createdAt: taxReturns.createdAt,
        })
        .from(taxReturns)
        .innerJoin(clients, eq(clients.id, taxReturns.clientId))
        .where(and(...conds))
        .orderBy(desc(taxReturns.taxYear), desc(taxReturns.createdAt))
        .limit(500);
      res.json({ items: rows });
    },
  );

  // PATCH a single section. Sets is_manual_override=true so a future
  // outline reparse skips this row. Audits as SECTION_EDITED. Caller
  // must hold engagement:write; cross-firm sections 404.
  router.patch(
    '/:returnId/sections/:sectionId',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = PatchSectionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
        return;
      }
      // Cross-firm guard via the parent return.
      const [ret] = await deps.db
        .select({ id: taxReturns.id })
        .from(taxReturns)
        .where(
          and(eq(taxReturns.id, req.params['returnId']!), eq(taxReturns.firmId, session.firmId)),
        )
        .limit(1);
      if (!ret) {
        res.status(404).json({ error: 'return_not_found' });
        return;
      }
      const sectionId = req.params['sectionId']!;
      // Confirm the section actually belongs to this return.
      const [existing] = await deps.db
        .select({ id: taxReturnSections.id })
        .from(taxReturnSections)
        .where(and(eq(taxReturnSections.id, sectionId), eq(taxReturnSections.returnId, ret.id)))
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'section_not_found' });
        return;
      }
      const patch: Record<string, unknown> = { isManualOverride: true };
      if (parsed.data.normalizedTitle !== undefined)
        patch['normalizedTitle'] = parsed.data.normalizedTitle;
      if (parsed.data.kind !== undefined) patch['kind'] = parsed.data.kind;
      if (parsed.data.formCode !== undefined) patch['formCode'] = parsed.data.formCode;
      if (parsed.data.recipientName !== undefined)
        patch['recipientName'] = parsed.data.recipientName;
      if (parsed.data.releasable !== undefined) patch['releasable'] = parsed.data.releasable;
      if (parsed.data.startPage !== undefined) patch['startPage'] = parsed.data.startPage;
      if (parsed.data.endPage !== undefined) patch['endPage'] = parsed.data.endPage;
      await deps.db.update(taxReturnSections).set(patch).where(eq(taxReturnSections.id, sectionId));
      await appendAccessLog({
        db: deps.db,
        returnId: ret.id,
        event: 'SECTION_EDITED',
        actorKind: 'STAFF',
        actorRef: session.appUserId,
        actorIp: req.ip ?? null,
        actorUserAgent: req.get('user-agent') ?? null,
        sectionId,
        metadata: { fields: Object.keys(parsed.data) },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // Automated re-parse — re-derive sections from the source PDF's
  // bookmark outline (falling back to header detection). Replaces all
  // sections (manual edits included) and flips the return to PARSED.
  // Blocked once RELEASED (releases reference section ids).
  router.post(
    '/:returnId/reparse',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const storage = resolveStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const returnId = req.params['returnId']!;
      const [ret] = await deps.db
        .select({
          id: taxReturns.id,
          status: taxReturns.status,
          sourceStorageKey: files.storageKey,
          sourceDeletedAt: files.deletedAt,
        })
        .from(taxReturns)
        .leftJoin(files, eq(files.id, taxReturns.sourceFileId))
        .where(and(eq(taxReturns.id, returnId), eq(taxReturns.firmId, session.firmId)))
        .limit(1);
      if (!ret) {
        res.status(404).json({ error: 'tax_return_not_found' });
        return;
      }
      if (ret.status === 'RELEASED') {
        res.status(409).json({ error: 'cannot_reparse_released' });
        return;
      }
      if (!ret.sourceStorageKey || ret.sourceDeletedAt) {
        res.status(409).json({ error: 'no_source_file' });
        return;
      }
      try {
        const parsedSections = await parseReturnSections({
          storage,
          sourceStorageKey: ret.sourceStorageKey,
        });
        await applyParsedSections(deps.db, returnId, parsedSections);
        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'tax_return',
          entityId: returnId,
          actorAppUserId: session.appUserId,
          after: {
            kind: 'reparse',
            strategy: parsedSections.strategy,
            sections: parsedSections.sections.length,
            totalPages: parsedSections.totalPages,
          },
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        }).catch(() => undefined);
        res.json({
          ok: true,
          strategy: parsedSections.strategy,
          sections: parsedSections.sections.length,
          totalPages: parsedSections.totalPages,
        });
      } catch (err) {
        logger.warn({ err, returnId }, 'tax-return reparse failed');
        res.status(502).json({ error: 'parse_failed', detail: (err as Error).message });
      }
    },
  );

  // Manual section create — staff adds a section by page range. Flagged
  // is_manual_override so a later reparse warning is meaningful.
  router.post(
    '/:returnId/sections',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = CreateSectionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
        return;
      }
      const returnId = req.params['returnId']!;
      const [ret] = await deps.db
        .select({ id: taxReturns.id })
        .from(taxReturns)
        .where(and(eq(taxReturns.id, returnId), eq(taxReturns.firmId, session.firmId)))
        .limit(1);
      if (!ret) {
        res.status(404).json({ error: 'tax_return_not_found' });
        return;
      }
      const [maxRow] = await deps.db
        .select({ ordinal: taxReturnSections.ordinal })
        .from(taxReturnSections)
        .where(eq(taxReturnSections.returnId, ret.id))
        .orderBy(desc(taxReturnSections.ordinal))
        .limit(1);
      const nextOrdinal = (maxRow?.ordinal ?? -1) + 1;
      const [row] = await deps.db
        .insert(taxReturnSections)
        .values({
          returnId: ret.id,
          ordinal: nextOrdinal,
          depth: 0,
          rawTitle: parsed.data.normalizedTitle,
          normalizedTitle: parsed.data.normalizedTitle,
          kind: parsed.data.kind,
          formCode: parsed.data.formCode,
          recipientName: parsed.data.recipientName,
          startPage: parsed.data.startPage,
          endPage: parsed.data.endPage,
          releasable: parsed.data.releasable,
          parseConfidence: 0,
          isManualOverride: true,
        })
        .returning({ id: taxReturnSections.id });
      await appendAccessLog({
        db: deps.db,
        returnId: ret.id,
        event: 'SECTION_EDITED',
        actorKind: 'STAFF',
        actorRef: session.appUserId,
        actorIp: req.ip ?? null,
        actorUserAgent: req.get('user-agent') ?? null,
        sectionId: row!.id,
        metadata: { action: 'created' },
      }).catch(() => undefined);
      res.status(201).json({ sectionId: row!.id });
    },
  );

  // Manual section delete.
  router.delete(
    '/:returnId/sections/:sectionId',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const returnId = req.params['returnId']!;
      const [ret] = await deps.db
        .select({ id: taxReturns.id })
        .from(taxReturns)
        .where(and(eq(taxReturns.id, returnId), eq(taxReturns.firmId, session.firmId)))
        .limit(1);
      if (!ret) {
        res.status(404).json({ error: 'tax_return_not_found' });
        return;
      }
      const deleted = await deps.db
        .delete(taxReturnSections)
        .where(
          and(
            eq(taxReturnSections.id, req.params['sectionId']!),
            eq(taxReturnSections.returnId, ret.id),
          ),
        )
        .returning({ id: taxReturnSections.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: 'section_not_found' });
        return;
      }
      await appendAccessLog({
        db: deps.db,
        returnId: ret.id,
        event: 'SECTION_EDITED',
        actorKind: 'STAFF',
        actorRef: session.appUserId,
        actorIp: req.ip ?? null,
        actorUserAgent: req.get('user-agent') ?? null,
        sectionId: req.params['sectionId']!,
        metadata: { action: 'deleted' },
      }).catch(() => undefined);
      res.status(204).end();
    },
  );

  // Detail endpoint for the staff release dialog: return meta +
  // sections + every active release. The release-creation UI needs
  // sections to drive the SELECTED-scope picker.
  router.get(
    '/:returnId',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const returnId = req.params['returnId']!;
      const [ret] = await deps.db
        .select({
          id: taxReturns.id,
          clientId: taxReturns.clientId,
          clientName: clients.name,
          taxYear: taxReturns.taxYear,
          formCode: taxReturns.formCode,
          jurisdiction: taxReturns.jurisdiction,
          title: taxReturns.title,
          status: taxReturns.status,
          releaseKind: taxReturns.releaseKind,
          totalPages: taxReturns.totalPages,
          releasedAt: taxReturns.releasedAt,
          createdAt: taxReturns.createdAt,
          // 0102 — backing PDF, so staff can share the return via the file flow.
          sourceFileId: taxReturns.sourceFileId,
        })
        .from(taxReturns)
        .innerJoin(clients, eq(clients.id, taxReturns.clientId))
        .where(and(eq(taxReturns.id, returnId), eq(taxReturns.firmId, session.firmId)))
        .limit(1);
      if (!ret) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const sectionsRows = await deps.db
        .select({
          id: taxReturnSections.id,
          ordinal: taxReturnSections.ordinal,
          depth: taxReturnSections.depth,
          parentSectionId: taxReturnSections.parentSectionId,
          title: taxReturnSections.normalizedTitle,
          kind: taxReturnSections.kind,
          formCode: taxReturnSections.formCode,
          startPage: taxReturnSections.startPage,
          endPage: taxReturnSections.endPage,
          recipientName: taxReturnSections.recipientName,
          releasable: taxReturnSections.releasable,
          parseConfidence: taxReturnSections.parseConfidence,
          isManualOverride: taxReturnSections.isManualOverride,
        })
        .from(taxReturnSections)
        .where(eq(taxReturnSections.returnId, returnId));
      const releaseRows = await deps.db
        .select({
          id: taxReturnReleases.id,
          releasedToClientId: taxReturnReleases.releasedToClientId,
          clientName: clients.name,
          scope: taxReturnReleases.scope,
          sectionIds: taxReturnReleases.sectionIds,
          clientCanDownload: taxReturnReleases.clientCanDownload,
          coverNote: taxReturnReleases.coverNote,
          releasedAt: taxReturnReleases.releasedAt,
          revokedAt: taxReturnReleases.revokedAt,
        })
        .from(taxReturnReleases)
        .leftJoin(clients, eq(clients.id, taxReturnReleases.releasedToClientId))
        .where(and(eq(taxReturnReleases.returnId, returnId), isNull(taxReturnReleases.revokedAt)));
      res.json({
        return: ret,
        sections: sectionsRows.sort((a, b) => a.ordinal - b.ordinal),
        releases: releaseRows,
      });
    },
  );

  // -------------------------------------------------------------------
  // In-office signature packages assembled from the return's bookmarks.
  // -------------------------------------------------------------------

  // GET /:returnId/signature-detect — preview the signature pages found in
  // the return PDF + the default-document templates for its return type.
  router.get(
    '/:returnId/signature-detect',
    requirePermission(deps, 'proposal:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const result = await detectSignaturePagesForReturn(
        deps.db,
        resolveStorage(deps),
        session.firmId,
        req.params['returnId']!,
      );
      if (!result) {
        res.status(404).json({ error: 'tax_return_not_found' });
        return;
      }
      res.json(result);
    },
  );

  // POST /:returnId/signature-doc — upload a one-off ad-hoc PDF for a signing
  // session; returns its storage key to pass back as adHocKeys.
  router.post(
    '/:returnId/signature-doc',
    requirePermission(deps, 'proposal:write'),
    express.raw({ type: 'application/pdf', limit: 25 * 1024 * 1024 }),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const storage = resolveStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'empty_body' });
        return;
      }
      const key = `signatures/adhoc/${session.firmId}/${randomUUID()}.pdf`;
      await storage.put(key, body, { contentType: 'application/pdf' });
      res.json({ key });
    },
  );

  // POST /:returnId/signature-request — merge the selected return pages +
  // templates + ad-hoc docs into one draft signature package.
  router.post(
    '/:returnId/signature-request',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const storage = resolveStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const parsed = SignaturePackageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
        return;
      }
      const result = await createSignaturePackageFromReturn(deps.db, storage, {
        firmId: session.firmId,
        returnId: req.params['returnId']!,
        actorId: session.appUserId,
        signers: parsed.data.signers,
        returnPages: parsed.data.returnPages,
        templateIds: parsed.data.templateIds,
        adHocKeys: parsed.data.adHocKeys,
      });
      if (!result.ok) {
        const status = result.code === 'not_found' ? 404 : 422;
        res.status(status).json({ error: result.code });
        return;
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'signature_request.from_return',
        entityId: result.requestId,
        actorAppUserId: session.appUserId,
        after: { taxReturnId: req.params['returnId'] },
      });
      res.json({ requestId: result.requestId });
    },
  );

  return router;
}
