// SPDX-License-Identifier: Elastic-2.0
//
// File visibility + completion endpoints.
//
//   PATCH /:id/visibility           — Phase 6, single-file flip
//   POST  /bulk-visibility          — Phase 6, multi-file flip
//   POST  /:id/complete             — Phase 8, confirm a presigned upload
//
// Visibility writes append a row to file_visibility_events so the
// portal "First viewed" audit and compliance exports can reconstruct
// the timeline. Asymmetric publish/unpublish per addendum §3.7.
//
// /complete is the second leg of the Phase-8 presigned-PUT upload:
// the FE PUTs the body directly to storage, then POSTs here so the
// server HEADs the object, picks up etag + actual size, and clears
// pending_upload. If the object isn't there yet, the row stays
// pending and the janitor sweeps it after 30 minutes.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { fileVisibilityEvents, files } from '@vibe/db/schema';
import {
  hasPermission,
  unionPermissions,
  type PermissionKey,
  type RoleSlug,
} from '@vibe/core/rbac';
import { roles, userRoles } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';

export interface FileVisibilityRoutesDeps extends RbacDeps {
  db: Database | null;
  /** Pre-built storage client. When omitted, the factory is invoked
   *  with process.env — useful for tests. */
  storageClient?: StorageClient;
}

// 0060 — added 'escrow'. Files in escrow are uploaded but gated by an
// invoice payment; the Stripe webhook + /payments/receive promote them
// to client_visible when the gating invoice clears.
const VISIBILITY_VALUES = ['private', 'client_visible', 'escrow'] as const;
type VisibilityValue = (typeof VISIBILITY_VALUES)[number];

const PatchSchema = z
  .object({
    visibility: z.enum(VISIBILITY_VALUES),
    reason: z.string().max(500).optional(),
    // Required when visibility === 'escrow'.
    invoiceId: z.string().uuid().optional(),
  })
  .refine((d) => d.visibility !== 'escrow' || d.invoiceId, {
    message: 'invoiceId required for escrow',
    path: ['invoiceId'],
  });

const BulkSchema = z
  .object({
    fileIds: z.array(z.string().uuid()).min(1).max(500),
    visibility: z.enum(VISIBILITY_VALUES),
    reason: z.string().max(500).optional(),
    invoiceId: z.string().uuid().optional(),
  })
  .refine((d) => d.visibility !== 'escrow' || d.invoiceId, {
    message: 'invoiceId required for escrow',
    path: ['invoiceId'],
  });

// Connect F.7 — escrow override. Limited to the escrow ⇄
// client_visible pair (private flips go through the normal PATCH
// path). Justification text >= 10 chars is required.
const EscrowOverrideSchema = z
  .object({
    targetVisibility: z.enum(['escrow', 'client_visible']),
    reason: z.string().min(10).max(500),
    invoiceId: z.string().uuid().optional(),
  })
  .refine((d) => d.targetVisibility !== 'escrow' || d.invoiceId, {
    message: 'invoiceId required when re-gating to escrow',
    path: ['invoiceId'],
  });

interface FlipResult {
  fileId: string;
  oldValue: VisibilityValue;
  newValue: VisibilityValue;
}

async function flipFiles(
  db: Database,
  firmId: string,
  fileIds: string[],
  newValue: VisibilityValue,
  actorId: string | null,
  reason: string | null,
  invoiceId?: string | null,
): Promise<FlipResult[]> {
  const flipped: FlipResult[] = [];
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: files.id, visibility: files.visibility })
      .from(files)
      .where(and(inArray(files.id, fileIds), eq(files.firmId, firmId), isNull(files.deletedAt)));
    for (const row of rows) {
      const current = row.visibility as VisibilityValue;
      if (current === newValue) continue;
      const patch: Record<string, unknown> = {
        visibility: newValue,
        modifiedAt: new Date(),
      };
      // 0060 — escrow requires invoice_id by DB constraint. Manual
      // flips OUT of escrow clear the gating invoice id so the row
      // doesn't carry stale metadata.
      if (newValue === 'escrow') {
        patch['invoiceId'] = invoiceId ?? null;
      } else if (current === 'escrow') {
        patch['invoiceId'] = null;
      }
      await tx.update(files).set(patch).where(eq(files.id, row.id));
      await tx.insert(fileVisibilityEvents).values({
        fileId: row.id,
        firmId,
        oldValue: current,
        newValue,
        changedBy: actorId,
        reason,
      });
      flipped.push({ fileId: row.id, oldValue: current, newValue });
    }
  });
  return flipped;
}

/**
 * Returns the required permission for a visibility flip. Asymmetric per
 * addendum §3.7: a user with `publish` but not `unpublish` can only
 * expose files, never revoke; a user with `unpublish` but not `publish`
 * can revoke a mistake but not expose new things.
 */
function requiredVisibilityPermission(target: VisibilityValue): PermissionKey {
  return target === 'client_visible' ? 'storage:file:publish' : 'storage:file:unpublish';
}

async function userHasPermission(
  deps: FileVisibilityRoutesDeps,
  appUserId: string,
  key: PermissionKey,
): Promise<boolean> {
  let slugs: RoleSlug[];
  if (deps.fakeUserRoles) {
    slugs = deps.fakeUserRoles.get(appUserId) ?? [];
  } else if (deps.db) {
    const rows = await deps.db
      .select({ slug: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.appUserId, appUserId));
    const known: RoleSlug[] = ['partner', 'manager', 'senior', 'staff', 'admin'];
    slugs = rows
      .map((r) => r.slug.toLowerCase() as RoleSlug)
      .filter((s): s is RoleSlug => known.includes(s));
  } else {
    slugs = [];
  }
  return hasPermission(unionPermissions(slugs), key);
}

export function createFileVisibilityRouter(deps: FileVisibilityRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.patch('/:id/visibility', async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const required = requiredVisibilityPermission(parsed.data.visibility);
    if (!(await userHasPermission(deps, session.appUserId, required))) {
      res.status(403).json({ error: 'forbidden', required });
      return;
    }
    const firmId = session.firmId;
    const actorId = session.appUserId;
    if (!deps.db) {
      res.json({ ok: true, flipped: 0 });
      return;
    }
    const flipped = await flipFiles(
      deps.db,
      firmId,
      [req.params['id']!],
      parsed.data.visibility,
      actorId,
      parsed.data.reason ?? null,
      parsed.data.invoiceId ?? null,
    );
    for (const f of flipped) {
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'file',
        entityId: f.fileId,
        actorAppUserId: actorId,
        before: { visibility: f.oldValue },
        after: { visibility: f.newValue, reason: parsed.data.reason ?? null },
      }).catch(() => undefined);
    }
    res.json({ ok: true, flipped: flipped.length });
  });

  router.post('/bulk-visibility', async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const parsed = BulkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const required = requiredVisibilityPermission(parsed.data.visibility);
    if (!(await userHasPermission(deps, session.appUserId, required))) {
      res.status(403).json({ error: 'forbidden', required });
      return;
    }
    const firmId = session.firmId;
    const actorId = session.appUserId;
    if (!deps.db) {
      res.json({ ok: true, flipped: 0 });
      return;
    }
    const flipped = await flipFiles(
      deps.db,
      firmId,
      parsed.data.fileIds,
      parsed.data.visibility,
      actorId,
      parsed.data.reason ?? null,
      parsed.data.invoiceId ?? null,
    );
    // Bulk audit summary — one row per actor batch keeps the audit
    // log readable when the admin pushes 500 files at once.
    if (flipped.length > 0) {
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'file_bulk_visibility',
        entityId: null,
        actorAppUserId: actorId,
        after: {
          count: flipped.length,
          visibility: parsed.data.visibility,
          reason: parsed.data.reason ?? null,
        },
      }).catch(() => undefined);
    }
    res.json({ ok: true, flipped: flipped.length, ids: flipped.map((f) => f.fileId) });
  });

  // ----- Connect F.7 — admin escrow override ---------------------------
  //
  // Lets a partner manually promote a file from escrow to client_visible
  // (release the deliverable without an invoice payment) or demote a
  // client_visible file back to escrow (re-gate access). Distinct from
  // the standard PATCH /:id/visibility path because:
  //   1. Permission is `billing:override` (partner-only), not the
  //      storage:file:publish/unpublish pair that staff have.
  //   2. The `reason` field is mandatory and must be >= 10 chars.
  //   3. The audit row records `override: true` so a future compliance
  //      export can distinguish manual overrides from natural payment-
  //      driven flips.
  router.post(
    '/:id/escrow-override',
    requirePermission(deps, 'billing:override'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = EscrowOverrideSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const flipped = await flipFiles(
        deps.db,
        session.firmId,
        [req.params['id']!],
        parsed.data.targetVisibility,
        session.appUserId,
        `[OVERRIDE] ${parsed.data.reason}`,
        parsed.data.invoiceId ?? null,
      );
      if (flipped.length === 0) {
        res.status(409).json({ error: 'no_change' });
        return;
      }
      const f = flipped[0]!;
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'file',
        entityId: f.fileId,
        actorAppUserId: session.appUserId,
        before: { visibility: f.oldValue },
        after: {
          visibility: f.newValue,
          override: true,
          reason: parsed.data.reason,
        },
      }).catch(() => undefined);
      res.json({ ok: true, fileId: f.fileId, oldValue: f.oldValue, newValue: f.newValue });
    },
  );

  // ----- Phase 10 — presigned GET for staff download ------------------
  router.get(
    '/:id/download-url',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const firmId = session.firmId;
      if (!deps.db) {
        res.status(404).json({ error: 'no_db' });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({
          id: files.id,
          storageKey: files.storageKey,
          originalFilename: files.originalFilename,
          mimeType: files.mimeType,
          deletedAt: files.deletedAt,
          pendingUpload: files.pendingUpload,
        })
        .from(files)
        .where(and(eq(files.id, req.params['id']!), eq(files.firmId, firmId)))
        .limit(1);
      if (!row || row.deletedAt || row.pendingUpload) {
        res.status(404).json({ error: 'file_not_found' });
        return;
      }
      const ttlSeconds = 5 * 60;
      // `?inline=1` returns a URL the browser renders in place (PDF
      // preview) instead of downloading. We force Content-Type to the
      // stored mime (defaulting to application/pdf) so even objects B2
      // discovered as application/octet-stream still render.
      const inline = req.query['inline'] === '1' || req.query['inline'] === 'true';
      const url = await storage.presignGet(
        row.storageKey,
        ttlSeconds,
        inline
          ? {
              responseContentDisposition: 'inline',
              responseContentType: row.mimeType ?? 'application/pdf',
            }
          : undefined,
      );
      res.json({
        url,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        filename: row.originalFilename,
      });
    },
  );

  // ----- Phase 8 — confirm a presigned upload -------------------------
  router.post(
    '/:id/complete',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const firmId = session.firmId;
      const actorId = session.appUserId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({
          id: files.id,
          storageKey: files.storageKey,
          pendingUpload: files.pendingUpload,
        })
        .from(files)
        .where(and(eq(files.id, req.params['id']!), eq(files.firmId, firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'file_not_found' });
        return;
      }
      if (!row.pendingUpload) {
        // Already completed — idempotent.
        res.json({ ok: true, alreadyComplete: true });
        return;
      }
      const meta = await storage.head(row.storageKey);
      if (!meta) {
        res.status(409).json({ error: 'object_not_yet_landed', storageKey: row.storageKey });
        return;
      }
      await deps.db
        .update(files)
        .set({
          etag: meta.etag,
          sizeBytes: meta.sizeBytes,
          pendingUpload: false,
          modifiedAt: new Date(),
        })
        .where(eq(files.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'file',
        entityId: row.id,
        actorAppUserId: actorId,
        after: {
          completed: true,
          etag: meta.etag,
          sizeBytes: meta.sizeBytes,
        },
      }).catch(() => undefined);
      res.json({ ok: true, etag: meta.etag, sizeBytes: meta.sizeBytes });
    },
  );

  return router;
}

function getStorage(deps: FileVisibilityRoutesDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}
