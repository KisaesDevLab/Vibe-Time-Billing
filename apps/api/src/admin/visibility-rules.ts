// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Firm-level visibility-rule CRUD (Phase 6 of FILE_MANAGER_ADDENDUM.md).
//
//   GET  /              — list the firm's rules (priority desc)
//   PUT  /              — replace the whole rule pack atomically
//
// PUT is a full-replace rather than per-row PATCH so the admin UI can
// edit-then-save without juggling row ids. The transaction deletes the
// old set and re-inserts the new one; folder_sync_events is left alone.
//
// Permission gating uses `firm:settings:write` (already exists). Phase
// 7 keeps this gate — the addendum's "firm.settings.edit" maps to it.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { asc, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmFolderVisibilityRules } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface VisibilityRulesRoutesDeps extends RbacDeps {
  db: Database | null;
}

const RuleSchema = z.object({
  subfolderPattern: z.string().min(1).max(200),
  defaultVisibility: z.enum(['private', 'client_visible']),
  priority: z.number().int().min(0).max(1000),
  enabled: z.boolean().optional().default(true),
  notes: z.string().max(500).nullable().optional(),
});

const PutSchema = z.object({
  rules: z.array(RuleSchema).max(200),
});

export function createVisibilityRulesRouter(deps: VisibilityRulesRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const rows = await deps.db
        .select({
          id: firmFolderVisibilityRules.id,
          subfolderPattern: firmFolderVisibilityRules.subfolderPattern,
          defaultVisibility: firmFolderVisibilityRules.defaultVisibility,
          priority: firmFolderVisibilityRules.priority,
          enabled: firmFolderVisibilityRules.enabled,
          notes: firmFolderVisibilityRules.notes,
          createdAt: firmFolderVisibilityRules.createdAt,
        })
        .from(firmFolderVisibilityRules)
        .where(eq(firmFolderVisibilityRules.firmId, firmId))
        .orderBy(
          desc(firmFolderVisibilityRules.priority),
          asc(firmFolderVisibilityRules.createdAt),
        );
      res.json({ items: rows });
    },
  );

  router.put(
    '/',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = PutSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession?.firmId;
      const actorId = req.staffSession?.appUserId ?? null;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const db = deps.db;
      const before = await db
        .select({
          subfolderPattern: firmFolderVisibilityRules.subfolderPattern,
          defaultVisibility: firmFolderVisibilityRules.defaultVisibility,
          priority: firmFolderVisibilityRules.priority,
          enabled: firmFolderVisibilityRules.enabled,
        })
        .from(firmFolderVisibilityRules)
        .where(eq(firmFolderVisibilityRules.firmId, firmId));

      await db.transaction(async (tx) => {
        await tx
          .delete(firmFolderVisibilityRules)
          .where(eq(firmFolderVisibilityRules.firmId, firmId));
        if (parsed.data.rules.length > 0) {
          await tx.insert(firmFolderVisibilityRules).values(
            parsed.data.rules.map((r) => ({
              firmId,
              subfolderPattern: r.subfolderPattern,
              defaultVisibility: r.defaultVisibility,
              priority: r.priority,
              enabled: r.enabled ?? true,
              notes: r.notes ?? null,
            })),
          );
        }
      });

      await emitAudit(db, {
        action: 'UPDATE',
        entityType: 'firm_folder_visibility_rules',
        entityId: null,
        actorAppUserId: actorId,
        before: { rules: before },
        after: { rules: parsed.data.rules },
      }).catch(() => undefined);

      res.json({ ok: true, count: parsed.data.rules.length });
    },
  );

  return router;
}
