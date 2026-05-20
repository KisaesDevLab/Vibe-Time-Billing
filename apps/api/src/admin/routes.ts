// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin endpoints (Phase 4). Backs the firm-settings, office, and user
// admin UIs. RBAC-gated via `requirePermission`.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, firms, firmSettings, offices } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface AdminRoutesDeps extends RbacDeps {
  db: Database | null;
}

const InviteSchema = z.object({
  email: z.string().min(3).max(254),
  fullName: z.string().min(1).max(200),
  defaultOfficeId: z.string().uuid().optional(),
});

const OfficeSchema = z.object({
  name: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64),
  address: z.string().max(400).optional(),
  isDefault: z.boolean().optional(),
});

const FirmSettingsPatchSchema = z
  .object({
    adjustmentApprovalThresholdCents: z.number().int().nonnegative().optional(),
    aiMonthlyBudgetCents: z.number().int().nonnegative().optional(),
    timeEntryRoundingHours: z.enum(['0.10', '0.25', '0.00']).optional(),
    stepUpTimeoutMinutes: z.number().int().min(5).max(240).optional(),
    portalEnabled: z.boolean().optional(),
  })
  .strict();

export function createAdminRouter(deps: AdminRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/firm-settings',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(200).json({ firmId, settings: null });
        return;
      }
      const [firm] = await deps.db.select().from(firms).where(eq(firms.id, firmId)).limit(1);
      const [settings] = await deps.db
        .select()
        .from(firmSettings)
        .where(eq(firmSettings.firmId, firmId))
        .limit(1);
      res.json({ firm, settings });
    },
  );

  router.patch(
    '/firm-settings',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = FirmSettingsPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(200).json({ ok: true, applied: parsed.data });
        return;
      }
      await deps.db.update(firmSettings).set(parsed.data).where(eq(firmSettings.firmId, firmId));
      res.json({ ok: true });
    },
  );

  router.get(
    '/offices',
    requirePermission(deps, 'office:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ offices: [] });
        return;
      }
      const rows = await deps.db.select().from(offices).where(eq(offices.firmId, firmId));
      res.json({ offices: rows });
    },
  );

  router.post(
    '/offices',
    requirePermission(deps, 'office:write'),
    async (req: Request, res: Response) => {
      const parsed = OfficeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .insert(offices)
        .values({ firmId, ...parsed.data })
        .returning({ id: offices.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.get(
    '/users',
    requirePermission(deps, 'app_user:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ users: [] });
        return;
      }
      const rows = await deps.db
        .select({
          id: appUsers.id,
          email: appUsers.email,
          fullName: appUsers.fullName,
          status: appUsers.status,
          totpEnrolledAt: appUsers.totpEnrolledAt,
        })
        .from(appUsers)
        .where(eq(appUsers.firmId, firmId));
      res.json({ users: rows });
    },
  );

  router.post(
    '/users/invite',
    requirePermission(deps, 'app_user:invite'),
    async (req: Request, res: Response) => {
      const parsed = InviteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .insert(appUsers)
        .values({
          firmId,
          email: parsed.data.email,
          fullName: parsed.data.fullName,
          defaultOfficeId: parsed.data.defaultOfficeId ?? null,
        })
        .returning({ id: appUsers.id });
      res.status(201).json({ id: row?.id });
    },
  );

  return router;
}
