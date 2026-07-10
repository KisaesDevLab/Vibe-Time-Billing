// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// R1 — Tier config + firm-retainer-settings CRUD.
//
// Mounted at /api/staff/admin/retainer-tier-configs and
// /api/staff/admin/firm-retainer-settings. Partner-only writes;
// manager has read on tier configs.
//
// PUT /retainer-tier-configs/:returnType replaces BOTH tiers atomically:
// upserts the two tier_config rows (TIER_1 + TIER_2) and replaces the
// per-tier eligibility rows. Server validates each tier's required
// fields and the eligibility set in one transaction so the page either
// persists everything or nothing.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  firmRetainerSettings,
  retainerTierConfigs,
  retainerTierEligibleServices,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface RetainerConfigRoutesDeps extends RbacDeps {
  db: Database | null;
}

const RETURN_TYPES = ['1040', '1065', '1120', '1120S', '1041', '990'] as const;
type ReturnType = (typeof RETURN_TYPES)[number];

const TierInputSchema = z.object({
  name: z.string().min(1).max(120),
  // 0093 — description copy. Optional, nullable; trimmed before insert.
  description: z.string().max(4000).nullable().optional(),
  hours: z.number().positive().max(10000),
  baseFeeCents: z.number().int().nonnegative(),
  pctOfPrepFeeBps: z.number().int().min(0).max(10000),
  isActive: z.boolean(),
  eligibleWorkCodeIds: z.array(z.string().uuid()).min(1),
});

const PutTiersSchema = z.object({
  tier1: TierInputSchema,
  tier2: TierInputSchema,
});

const FirmSettingsSchema = z.object({
  featureEnabled: z.boolean().optional(),
  defaultBillerToggleOn: z.boolean().optional(),
  offerWindowDays: z.number().int().positive().max(365).optional(),
  prepFeeWorkCodeIds: z.array(z.string().uuid()).optional(),
  notifyOnBill: z.boolean().optional(),
  notifyDay30: z.boolean().optional(),
  notifyDay55: z.boolean().optional(),
  revenueGlAccount: z.string().max(80).nullable().optional(),
  offsetGlAccount: z.string().max(80).nullable().optional(),
  offerIntroMd: z.string().max(8000).nullable().optional(),
  offerTermsMd: z.string().max(20000).nullable().optional(),
});

export function createRetainerConfigRouter(deps: RetainerConfigRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // ----- tier configs -------------------------------------------------

  router.get(
    '/tier-configs',
    requirePermission(deps, 'retainer:tier_config:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const rt = typeof req.query['returnType'] === 'string' ? req.query['returnType'] : null;
      if (!rt || !RETURN_TYPES.includes(rt as ReturnType)) {
        res.status(400).json({ error: 'invalid_return_type' });
        return;
      }
      if (!deps.db) {
        res.json({ returnType: rt, tier1: null, tier2: null });
        return;
      }
      const configs = await deps.db
        .select()
        .from(retainerTierConfigs)
        .where(
          and(
            eq(retainerTierConfigs.firmId, session.firmId),
            eq(retainerTierConfigs.returnType, rt as ReturnType),
          ),
        );
      const tierIds = configs.map((c) => c.id);
      const eligibility = tierIds.length
        ? await deps.db
            .select()
            .from(retainerTierEligibleServices)
            .where(inArray(retainerTierEligibleServices.tierConfigId, tierIds))
        : [];
      const eligByTier = new Map<string, string[]>();
      for (const e of eligibility) {
        const list = eligByTier.get(e.tierConfigId) ?? [];
        list.push(e.workCodeId);
        eligByTier.set(e.tierConfigId, list);
      }
      const shape = (tier: 'TIER_1' | 'TIER_2'): unknown => {
        const row = configs.find((c) => c.tier === tier);
        if (!row) return null;
        return {
          id: row.id,
          name: row.name,
          description: row.description ?? null,
          hours: Number(row.hours),
          baseFeeCents: row.baseFeeCents,
          pctOfPrepFeeBps: row.pctOfPrepFeeBps,
          isActive: row.isActive,
          eligibleWorkCodeIds: eligByTier.get(row.id) ?? [],
        };
      };
      res.json({ returnType: rt, tier1: shape('TIER_1'), tier2: shape('TIER_2') });
    },
  );

  router.put(
    '/tier-configs/:returnType',
    requirePermission(deps, 'retainer:tier_config:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const rt = req.params['returnType'];
      if (!rt || !RETURN_TYPES.includes(rt as ReturnType)) {
        res.status(400).json({ error: 'invalid_return_type' });
        return;
      }
      const parsed = PutTiersSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      await deps.db.transaction(async (tx) => {
        for (const tier of ['TIER_1', 'TIER_2'] as const) {
          const input = tier === 'TIER_1' ? parsed.data.tier1 : parsed.data.tier2;
          // Upsert the tier_config row.
          const [existing] = await tx
            .select({ id: retainerTierConfigs.id })
            .from(retainerTierConfigs)
            .where(
              and(
                eq(retainerTierConfigs.firmId, session.firmId),
                eq(retainerTierConfigs.returnType, rt as ReturnType),
                eq(retainerTierConfigs.tier, tier),
              ),
            )
            .limit(1);
          let tierConfigId: string;
          const description =
            input.description != null && input.description.trim().length > 0
              ? input.description.trim()
              : null;
          if (existing) {
            await tx
              .update(retainerTierConfigs)
              .set({
                name: input.name,
                description,
                hours: String(input.hours),
                baseFeeCents: input.baseFeeCents,
                pctOfPrepFeeBps: input.pctOfPrepFeeBps,
                isActive: input.isActive,
                updatedAt: new Date(),
              })
              .where(eq(retainerTierConfigs.id, existing.id));
            tierConfigId = existing.id;
          } else {
            const [created] = await tx
              .insert(retainerTierConfigs)
              .values({
                firmId: session.firmId,
                returnType: rt as ReturnType,
                tier,
                name: input.name,
                description,
                hours: String(input.hours),
                baseFeeCents: input.baseFeeCents,
                pctOfPrepFeeBps: input.pctOfPrepFeeBps,
                isActive: input.isActive,
              })
              .returning({ id: retainerTierConfigs.id });
            if (!created) throw new Error('tier_config_insert_failed');
            tierConfigId = created.id;
          }
          // Replace eligibility set atomically.
          await tx
            .delete(retainerTierEligibleServices)
            .where(eq(retainerTierEligibleServices.tierConfigId, tierConfigId));
          await tx.insert(retainerTierEligibleServices).values(
            input.eligibleWorkCodeIds.map((workCodeId) => ({
              tierConfigId,
              workCodeId,
            })),
          );
        }
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'retainer_tier_config',
        entityId: null,
        actorAppUserId: session.appUserId,
        after: { returnType: rt },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // ----- firm-retainer-settings ---------------------------------------

  router.get(
    '/firm-settings',
    requirePermission(deps, 'retainer:tier_config:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ settings: null });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(firmRetainerSettings)
        .where(eq(firmRetainerSettings.firmId, session.firmId))
        .limit(1);
      if (!row) {
        // Auto-bootstrap so the page always has a row to edit.
        const [created] = await deps.db
          .insert(firmRetainerSettings)
          .values({ firmId: session.firmId })
          .returning();
        res.json({ settings: created ?? null });
        return;
      }
      res.json({ settings: row });
    },
  );

  router.put(
    '/firm-settings',
    requirePermission(deps, 'retainer:tier_config:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = FirmSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const update: Record<string, unknown> = { updatedAt: new Date() };
      const d = parsed.data;
      if (d.featureEnabled !== undefined) update['featureEnabled'] = d.featureEnabled;
      if (d.defaultBillerToggleOn !== undefined)
        update['defaultBillerToggleOn'] = d.defaultBillerToggleOn;
      if (d.offerWindowDays !== undefined) update['offerWindowDays'] = d.offerWindowDays;
      if (d.prepFeeWorkCodeIds !== undefined) update['prepFeeWorkCodeIds'] = d.prepFeeWorkCodeIds;
      if (d.notifyOnBill !== undefined) update['notifyOnBill'] = d.notifyOnBill;
      if (d.notifyDay30 !== undefined) update['notifyDay30'] = d.notifyDay30;
      if (d.notifyDay55 !== undefined) update['notifyDay55'] = d.notifyDay55;
      if (d.revenueGlAccount !== undefined) update['revenueGlAccount'] = d.revenueGlAccount;
      if (d.offsetGlAccount !== undefined) update['offsetGlAccount'] = d.offsetGlAccount;
      if (d.offerIntroMd !== undefined) update['offerIntroMd'] = d.offerIntroMd;
      if (d.offerTermsMd !== undefined) update['offerTermsMd'] = d.offerTermsMd;

      // Upsert: insert if missing, else update.
      const [existing] = await deps.db
        .select({ firmId: firmRetainerSettings.firmId })
        .from(firmRetainerSettings)
        .where(eq(firmRetainerSettings.firmId, session.firmId))
        .limit(1);
      if (!existing) {
        await deps.db.insert(firmRetainerSettings).values({ firmId: session.firmId, ...update });
      } else {
        await deps.db
          .update(firmRetainerSettings)
          .set(update)
          .where(eq(firmRetainerSettings.firmId, session.firmId));
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'firm_retainer_settings',
        entityId: session.firmId,
        actorAppUserId: session.appUserId,
        after: d,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}
