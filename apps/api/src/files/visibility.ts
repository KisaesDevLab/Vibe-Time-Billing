// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// File visibility endpoints (Phase 6 of FILE_MANAGER_ADDENDUM.md).
//
//   PATCH /:id/visibility           — single-file flip
//   POST  /bulk-visibility          — multi-file flip
//
// Every successful change appends a row to file_visibility_events so
// the portal "First viewed" audit, the staff "what's visible" filter,
// and compliance exports can reconstruct the visibility history.
//
// Permission gating uses `client:write` for now. Phase 7 swaps to
// `storage.file.publish` (for private → client_visible) and
// `storage.file.unpublish` (for the reverse) per the addendum's
// asymmetric-permission rule.

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

import { emitAudit } from '../auth/audit';
import { type RbacDeps } from '../auth/rbac-middleware';

export interface FileVisibilityRoutesDeps extends RbacDeps {
  db: Database | null;
}

const VISIBILITY_VALUES = ['private', 'client_visible'] as const;
type VisibilityValue = (typeof VISIBILITY_VALUES)[number];

const PatchSchema = z.object({
  visibility: z.enum(VISIBILITY_VALUES),
  reason: z.string().max(500).optional(),
});

const BulkSchema = z.object({
  fileIds: z.array(z.string().uuid()).min(1).max(500),
  visibility: z.enum(VISIBILITY_VALUES),
  reason: z.string().max(500).optional(),
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
): Promise<FlipResult[]> {
  const flipped: FlipResult[] = [];
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: files.id, visibility: files.visibility })
      .from(files)
      .where(and(inArray(files.id, fileIds), eq(files.firmId, firmId), isNull(files.deletedAt)));
    for (const row of rows) {
      const current = row.visibility as VisibilityValue;
      // No-op when already at target — per spec, never write an event
      // for a no-op flip.
      if (current === newValue) continue;
      await tx
        .update(files)
        .set({ visibility: newValue, modifiedAt: new Date() })
        .where(eq(files.id, row.id));
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

  return router;
}
