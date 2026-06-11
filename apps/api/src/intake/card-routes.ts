// SPDX-License-Identifier: Elastic-2.0
//
// Admin intake card settings (mounted at /api/staff/admin/intake). Controls
// which staff appear on the public intake page, their order/title, per-card
// notification prefs, and their headshot. Gated on firm:settings:write
// (read on firm:settings:read).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, firmConfig, intakeStaffCards } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface IntakeCardDeps extends RbacDeps {
  db: Database | null;
  storageClient?: StorageClient;
}

function getStorage(deps: IntakeCardDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

const PatchSchema = z.object({
  isVisible: z.boolean().optional(),
  acceptingUploads: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  displayTitle: z.string().max(120).nullable().optional(),
  notifyEmail: z.boolean().optional(),
  notifySms: z.boolean().optional(),
  notifyInApp: z.boolean().optional(),
});

const MAX_HEADSHOT_BYTES = 5 * 1024 * 1024;
const HEADSHOT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function createIntakeCardRouter(deps: IntakeCardDeps): Router {
  const router = express.Router();

  // GET /settings — firm-wide intake on/off.
  router.get(
    '/settings',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ enabled: false });
        return;
      }
      const [row] = await deps.db
        .select({ enabled: firmConfig.intakeEnabled })
        .from(firmConfig)
        .where(eq(firmConfig.firmId, firmId))
        .limit(1);
      res.json({ enabled: Boolean(row?.enabled) });
    },
  );

  // PATCH /settings — toggle the feature firm-wide.
  router.patch(
    '/settings',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actorId = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const enabled = Boolean((req.body as { enabled?: unknown })?.enabled);
      await deps.db
        .insert(firmConfig)
        .values({ firmId, intakeEnabled: enabled })
        .onConflictDoUpdate({
          target: firmConfig.firmId,
          set: { intakeEnabled: enabled, updatedAt: new Date() },
        });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'firm_config',
        entityId: null,
        actorAppUserId: actorId,
        after: { intakeEnabled: enabled },
      }).catch(() => undefined);
      res.json({ ok: true, enabled });
    },
  );

  // GET / — every staff card (admin view).
  router.get(
    '/',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ cards: [] });
        return;
      }
      const rows = await deps.db
        .select({
          userId: intakeStaffCards.userId,
          name: appUsers.fullName,
          status: appUsers.status,
          isVisible: intakeStaffCards.isVisible,
          acceptingUploads: intakeStaffCards.acceptingUploads,
          displayOrder: intakeStaffCards.displayOrder,
          displayTitle: intakeStaffCards.displayTitle,
          notifyEmail: intakeStaffCards.notifyEmail,
          notifySms: intakeStaffCards.notifySms,
          notifyInApp: intakeStaffCards.notifyInApp,
          headshotObjectKey: intakeStaffCards.headshotObjectKey,
        })
        .from(intakeStaffCards)
        .innerJoin(appUsers, eq(appUsers.id, intakeStaffCards.userId))
        .where(eq(intakeStaffCards.firmId, firmId))
        .orderBy(asc(intakeStaffCards.displayOrder), asc(appUsers.fullName));
      res.json({
        cards: rows.map((r) => ({
          userId: r.userId,
          name: r.name,
          active: r.status === 'ACTIVE',
          isVisible: r.isVisible,
          acceptingUploads: r.acceptingUploads,
          displayOrder: r.displayOrder,
          displayTitle: r.displayTitle,
          notifyEmail: r.notifyEmail,
          notifySms: r.notifySms,
          notifyInApp: r.notifyInApp,
          hasHeadshot: Boolean(r.headshotObjectKey),
        })),
      });
    },
  );

  // PATCH /:userId — update a card.
  router.patch(
    '/:userId',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actorId = req.staffSession!.appUserId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const updates = { ...parsed.data, updatedAt: new Date() };
      const [row] = await deps.db
        .update(intakeStaffCards)
        .set(updates)
        .where(
          and(
            eq(intakeStaffCards.firmId, firmId),
            eq(intakeStaffCards.userId, req.params['userId']!),
          ),
        )
        .returning({ userId: intakeStaffCards.userId });
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'intake_staff_card',
        entityId: null,
        actorAppUserId: actorId,
        after: { userId: req.params['userId'], ...parsed.data },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // POST /:userId/headshot — raw-body image upload.
  router.post(
    '/:userId/headshot',
    requirePermission(deps, 'firm:settings:write'),
    express.raw({ type: () => true, limit: MAX_HEADSHOT_BYTES + 1024 }),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const mimeType = String(req.query['mimeType'] ?? '').slice(0, 100);
      if (!HEADSHOT_MIME.has(mimeType)) {
        res.status(415).json({ error: 'unsupported_type' });
        return;
      }
      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.byteLength === 0 || body.byteLength > MAX_HEADSHOT_BYTES) {
        res.status(400).json({ error: 'invalid_size' });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const userId = req.params['userId']!;
      const key = `intake/headshots/${firmId}/${userId}`;
      try {
        await storage.put(key, body, { contentType: mimeType });
      } catch {
        res.status(502).json({ error: 'put_failed' });
        return;
      }
      const [row] = await deps.db
        .update(intakeStaffCards)
        .set({ headshotObjectKey: key, updatedAt: new Date() })
        .where(and(eq(intakeStaffCards.firmId, firmId), eq(intakeStaffCards.userId, userId)))
        .returning({ userId: intakeStaffCards.userId });
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ ok: true });
    },
  );

  // DELETE /:userId/headshot — clear it.
  router.delete(
    '/:userId/headshot',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      await deps.db
        .update(intakeStaffCards)
        .set({ headshotObjectKey: null, updatedAt: new Date() })
        .where(
          and(
            eq(intakeStaffCards.firmId, firmId),
            eq(intakeStaffCards.userId, req.params['userId']!),
          ),
        );
      res.json({ ok: true });
    },
  );

  return router;
}
