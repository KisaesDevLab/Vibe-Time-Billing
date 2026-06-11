// SPDX-License-Identifier: Elastic-2.0
//
// Vibe Filer staff API — document inbox & routing.
//
//   POST   /scan                     re-list Inbox/ and re-match (cache upsert)
//   GET    /inbox                    current review queue
//   PATCH  /inbox/:id                per-row review state / manual assign
//   GET    /profiles                 routing profiles
//   POST   /profiles                 create
//   PATCH  /profiles/:id             rename / activate (single active)
//   DELETE /profiles/:id             delete
//   GET    /rules?profileId          rules for a profile (ordered)
//   POST   /rules                    create
//   PATCH  /rules/:id                update
//   DELETE /rules/:id                delete
//   POST   /rules/reorder            { profileId, orderedIds }
//   POST   /commit                   { itemIds } → enqueue route jobs (batch)
//   GET    /history                  routed batches
//   GET    /history/:batchId         per-file log
//   POST   /history/:batchId/undo    undo a batch
//   POST   /history/log/:logId/undo  undo one file
//
// Permissions: view → storage:folder:view; route/commit/undo →
// storage:folder:edit; profiles/rules admin → storage:folder:bind.

import express, { type Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  clients,
  inboxItems,
  inboxRoutingLog,
  inboxRoutingProfiles,
  inboxRoutingRules,
} from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { scanInbox } from './scan';
import { enqueueFilerRoute, enqueueFilerUndo } from './queue';

export interface FilerRoutesDeps extends RbacDeps {
  db: Database | null;
  storage?: StorageClient | null;
}

function resolveStorage(deps: FilerRoutesDeps): StorageClient | null {
  if (deps.storage) return deps.storage;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

const ReviewSchema = z.object({
  reviewAction: z.enum(['file', 'flag_tax', 'skip']).nullable().optional(),
  overrideFolder: z.string().max(512).nullable().optional(),
  overrideYear: z.number().int().min(1900).max(2999).nullable().optional(),
  matchedClient: z.string().uuid().nullable().optional(),
  flagFormCode: z.string().max(40).nullable().optional(),
  flagTaxYear: z.number().int().min(1900).max(2999).nullable().optional(),
  included: z.boolean().optional(),
});

const ProfileSchema = z.object({
  name: z.string().min(1).max(120),
  isActive: z.boolean().optional(),
});
const RuleSchema = z.object({
  profileId: z.string().uuid(),
  name: z.string().min(1).max(120),
  identifier: z.string().max(200).default(''),
  matchMode: z.enum(['contains', 'starts_with', 'regex']).default('contains'),
  caseSensitive: z.boolean().default(false),
  targetPath: z.string().max(512).default(''),
  yearBehavior: z.enum(['none', 'current_only', 'current_and_next', 'previous']).default('none'),
  isTaxReturn: z.boolean().default(false),
  enabled: z.boolean().default(true),
  notes: z.string().max(2000).nullable().optional(),
});
const RulePatchSchema = RuleSchema.partial().omit({ profileId: true });

export function createFilerRouter(deps: FilerRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['id', 'profileId', 'logId', 'batchId']);

  // ── Scan + queue ──────────────────────────────────────────────────
  router.post('/scan', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
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
    try {
      const result = await scanInbox(deps.db, storage, session.firmId);
      res.json(result);
    } catch (err) {
      logger.warn({ err }, 'filer scan failed');
      res
        .status(502)
        .json({ error: 'scan_failed', detail: err instanceof Error ? err.message : undefined });
    }
  });

  router.get('/inbox', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const rows = await deps.db
      .select({
        id: inboxItems.id,
        objectKey: inboxItems.objectKey,
        originalName: inboxItems.originalName,
        sizeBytes: inboxItems.sizeBytes,
        parsedName: inboxItems.parsedName,
        parsedId: inboxItems.parsedId,
        parsedYear: inboxItems.parsedYear,
        matchStatus: inboxItems.matchStatus,
        matchedClient: inboxItems.matchedClient,
        clientName: clients.name,
        clientExternalId: clients.externalId,
        suggestedRule: inboxItems.suggestedRule,
        suggestedPath: inboxItems.suggestedPath,
        reviewAction: inboxItems.reviewAction,
        overrideFolder: inboxItems.overrideFolder,
        overrideYear: inboxItems.overrideYear,
        flagFormCode: inboxItems.flagFormCode,
        flagTaxYear: inboxItems.flagTaxYear,
        included: inboxItems.included,
      })
      .from(inboxItems)
      .leftJoin(clients, eq(clients.id, inboxItems.matchedClient))
      .where(eq(inboxItems.firmId, session.firmId))
      .orderBy(desc(inboxItems.discoveredAt));
    res.json({ items: rows });
  });

  router.get(
    '/inbox/:id/preview-url',
    requirePermission(deps, 'storage:folder:view'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({ objectKey: inboxItems.objectKey, name: inboxItems.originalName })
        .from(inboxItems)
        .where(and(eq(inboxItems.id, req.params['id']!), eq(inboxItems.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const storage = resolveStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const url = await storage.presignGet(row.objectKey, 300, {
        responseContentDisposition: 'inline',
        responseContentType: 'application/pdf',
      });
      res.json({ url, filename: row.name });
    },
  );

  router.patch('/inbox/:id', requirePermission(deps, 'storage:folder:edit'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = ReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }
    const set: Record<string, unknown> = { reviewedBy: session.appUserId, updatedAt: new Date() };
    for (const k of [
      'reviewAction',
      'overrideFolder',
      'overrideYear',
      'matchedClient',
      'flagFormCode',
      'flagTaxYear',
      'included',
    ] as const) {
      if (parsed.data[k] !== undefined) set[k] = parsed.data[k];
    }
    const [row] = await deps.db
      .update(inboxItems)
      .set(set)
      .where(and(eq(inboxItems.id, req.params['id']!), eq(inboxItems.firmId, session.firmId)))
      .returning({ id: inboxItems.id });
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ok: true });
  });

  // ── Profiles ──────────────────────────────────────────────────────
  router.get('/profiles', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select()
      .from(inboxRoutingProfiles)
      .where(eq(inboxRoutingProfiles.firmId, session.firmId))
      .orderBy(desc(inboxRoutingProfiles.createdAt));
    res.json({ items });
  });

  router.post('/profiles', requirePermission(deps, 'storage:folder:bind'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = ProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const [row] = await deps.db
      .insert(inboxRoutingProfiles)
      .values({
        firmId: session.firmId,
        name: parsed.data.name,
        isActive: parsed.data.isActive ?? false,
      })
      .returning({ id: inboxRoutingProfiles.id });
    if (parsed.data.isActive) await activateProfile(deps.db, session.firmId, row!.id);
    res.status(201).json({ id: row!.id });
  });

  router.patch(
    '/profiles/:id',
    requirePermission(deps, 'storage:folder:bind'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ProfileSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (parsed.data.name !== undefined) {
        await deps.db
          .update(inboxRoutingProfiles)
          .set({ name: parsed.data.name })
          .where(
            and(
              eq(inboxRoutingProfiles.id, req.params['id']!),
              eq(inboxRoutingProfiles.firmId, session.firmId),
            ),
          );
      }
      if (parsed.data.isActive) await activateProfile(deps.db, session.firmId, req.params['id']!);
      res.json({ ok: true });
    },
  );

  router.delete(
    '/profiles/:id',
    requirePermission(deps, 'storage:folder:bind'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      await deps.db
        .delete(inboxRoutingProfiles)
        .where(
          and(
            eq(inboxRoutingProfiles.id, req.params['id']!),
            eq(inboxRoutingProfiles.firmId, session.firmId),
          ),
        );
      res.status(204).end();
    },
  );

  // ── Rules ─────────────────────────────────────────────────────────
  router.get('/rules', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const profileId = typeof req.query['profileId'] === 'string' ? req.query['profileId'] : null;
    if (!profileId) {
      res.status(400).json({ error: 'profileId_required' });
      return;
    }
    // Scope: the profile must belong to the firm.
    const [prof] = await deps.db
      .select({ id: inboxRoutingProfiles.id })
      .from(inboxRoutingProfiles)
      .where(
        and(
          eq(inboxRoutingProfiles.id, profileId),
          eq(inboxRoutingProfiles.firmId, session.firmId),
        ),
      )
      .limit(1);
    if (!prof) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select()
      .from(inboxRoutingRules)
      .where(eq(inboxRoutingRules.profileId, profileId))
      .orderBy(inboxRoutingRules.sortOrder);
    res.json({ items });
  });

  router.post('/rules', requirePermission(deps, 'storage:folder:bind'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = RuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }
    if (!(await profileInFirm(deps.db, session.firmId, parsed.data.profileId))) {
      res.status(404).json({ error: 'profile_not_found' });
      return;
    }
    const [{ next } = { next: 0 }] = await deps.db
      .select({ next: sql<number>`COALESCE(MAX(${inboxRoutingRules.sortOrder}), -1) + 1` })
      .from(inboxRoutingRules)
      .where(eq(inboxRoutingRules.profileId, parsed.data.profileId));
    const [row] = await deps.db
      .insert(inboxRoutingRules)
      .values({ ...parsed.data, notes: parsed.data.notes ?? null, sortOrder: next })
      .returning({ id: inboxRoutingRules.id });
    res.status(201).json({ id: row!.id });
  });

  router.patch('/rules/:id', requirePermission(deps, 'storage:folder:bind'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = RulePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    // Scope via join to the firm's profiles.
    const owned = await firmRuleIds(deps.db, session.firmId);
    if (!owned.has(req.params['id']!)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await deps.db
      .update(inboxRoutingRules)
      .set(parsed.data)
      .where(eq(inboxRoutingRules.id, req.params['id']!));
    res.json({ ok: true });
  });

  router.delete('/rules/:id', requirePermission(deps, 'storage:folder:bind'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const owned = await firmRuleIds(deps.db, session.firmId);
    if (!owned.has(req.params['id']!)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await deps.db.delete(inboxRoutingRules).where(eq(inboxRoutingRules.id, req.params['id']!));
    res.status(204).end();
  });

  router.post(
    '/rules/reorder',
    requirePermission(deps, 'storage:folder:bind'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const schema = z.object({
        profileId: z.string().uuid(),
        orderedIds: z.array(z.string().uuid()),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!(await profileInFirm(deps.db, session.firmId, parsed.data.profileId))) {
        res.status(404).json({ error: 'profile_not_found' });
        return;
      }
      await deps.db.transaction(async (tx) => {
        for (let i = 0; i < parsed.data.orderedIds.length; i++) {
          await tx
            .update(inboxRoutingRules)
            .set({ sortOrder: i })
            .where(
              and(
                eq(inboxRoutingRules.id, parsed.data.orderedIds[i]!),
                eq(inboxRoutingRules.profileId, parsed.data.profileId),
              ),
            );
        }
      });
      res.json({ ok: true });
    },
  );

  // ── Commit → route jobs ───────────────────────────────────────────
  router.post('/commit', requirePermission(deps, 'storage:folder:edit'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const schema = z.object({ itemIds: z.array(z.string().uuid()).min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const rows = await deps.db
      .select({
        id: inboxItems.id,
        matchStatus: inboxItems.matchStatus,
        included: inboxItems.included,
      })
      .from(inboxItems)
      .where(
        and(eq(inboxItems.firmId, session.firmId), inArray(inboxItems.id, parsed.data.itemIds)),
      );
    const routable = rows.filter(
      (r) => r.included && r.matchStatus !== 'folder_unbound' && r.matchStatus !== 'unparseable',
    );
    if (routable.length === 0) {
      res.status(400).json({ error: 'nothing_routable' });
      return;
    }
    const batchId = randomUUID();
    for (const r of routable) {
      await enqueueFilerRoute({
        firmId: session.firmId,
        actorId: session.appUserId,
        batchId,
        itemId: r.id,
      });
    }
    res.status(202).json({ batchId, count: routable.length });
  });

  // ── History + undo ────────────────────────────────────────────────
  router.get('/history', requirePermission(deps, 'storage:folder:view'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select({
        batchId: inboxRoutingLog.batchId,
        at: sql<string>`MAX(${inboxRoutingLog.createdAt})`,
        total: sql<number>`COUNT(*)::int`,
        filed: sql<number>`COUNT(*) FILTER (WHERE ${inboxRoutingLog.action} IN ('filed','tax_flagged'))::int`,
        reversed: sql<number>`COUNT(*) FILTER (WHERE ${inboxRoutingLog.status} = 'reversed')::int`,
      })
      .from(inboxRoutingLog)
      .where(eq(inboxRoutingLog.firmId, session.firmId))
      .groupBy(inboxRoutingLog.batchId)
      .orderBy(desc(sql`MAX(${inboxRoutingLog.createdAt})`))
      .limit(100);
    res.json({ items });
  });

  router.get(
    '/history/:batchId',
    requirePermission(deps, 'storage:folder:view'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(inboxRoutingLog)
        .where(
          and(
            eq(inboxRoutingLog.firmId, session.firmId),
            eq(inboxRoutingLog.batchId, req.params['batchId']!),
          ),
        )
        .orderBy(desc(inboxRoutingLog.createdAt));
      res.json({ items });
    },
  );

  router.post(
    '/history/:batchId/undo',
    requirePermission(deps, 'storage:folder:edit'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const rows = await deps.db
        .select({ id: inboxRoutingLog.id })
        .from(inboxRoutingLog)
        .where(
          and(
            eq(inboxRoutingLog.firmId, session.firmId),
            eq(inboxRoutingLog.batchId, req.params['batchId']!),
            eq(inboxRoutingLog.status, 'success'),
            inArray(inboxRoutingLog.action, ['filed', 'tax_flagged']),
          ),
        );
      for (const r of rows) {
        await enqueueFilerUndo({ firmId: session.firmId, actorId: session.appUserId, logId: r.id });
      }
      res.status(202).json({ count: rows.length });
    },
  );

  router.post(
    '/history/log/:logId/undo',
    requirePermission(deps, 'storage:folder:edit'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({ id: inboxRoutingLog.id, status: inboxRoutingLog.status })
        .from(inboxRoutingLog)
        .where(
          and(
            eq(inboxRoutingLog.id, req.params['logId']!),
            eq(inboxRoutingLog.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!row || row.status !== 'success') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await enqueueFilerUndo({ firmId: session.firmId, actorId: session.appUserId, logId: row.id });
      res.status(202).json({ ok: true });
    },
  );

  return router;
}

// ── helpers ───────────────────────────────────────────────────────────
async function activateProfile(db: Database, firmId: string, profileId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(inboxRoutingProfiles)
      .set({ isActive: false })
      .where(eq(inboxRoutingProfiles.firmId, firmId));
    await tx
      .update(inboxRoutingProfiles)
      .set({ isActive: true })
      .where(and(eq(inboxRoutingProfiles.id, profileId), eq(inboxRoutingProfiles.firmId, firmId)));
  });
}

async function profileInFirm(db: Database, firmId: string, profileId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: inboxRoutingProfiles.id })
    .from(inboxRoutingProfiles)
    .where(and(eq(inboxRoutingProfiles.id, profileId), eq(inboxRoutingProfiles.firmId, firmId)))
    .limit(1);
  return Boolean(row);
}

async function firmRuleIds(db: Database, firmId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: inboxRoutingRules.id })
    .from(inboxRoutingRules)
    .innerJoin(inboxRoutingProfiles, eq(inboxRoutingProfiles.id, inboxRoutingRules.profileId))
    .where(eq(inboxRoutingProfiles.firmId, firmId));
  return new Set(rows.map((r) => r.id));
}
