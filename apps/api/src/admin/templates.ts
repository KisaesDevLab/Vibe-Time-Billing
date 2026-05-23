// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Template CRUD endpoints (v2 Sprint D). Three template types share the
// same shape: list, get, create, clone, patch, archive. A small factory
// loop registers all three under /admin/templates/<kind>.
//
//   engagement   — engagement_template (fee structure + work codes)
//   letter       — engagement_letter_template (bodyHtml + variables)
//   client       — client_template (wizard prefills)

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientTemplates, engagementLetterTemplates, engagementTemplates } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';

export interface TemplateRoutesDeps extends RbacDeps {
  db: Database | null;
}

const FEE_STRUCTURES = [
  'HOURLY',
  'HOURLY_NTE',
  'FIXED_FEE',
  'FIXED_FEE_WITH_MILESTONES',
  'RECURRING_SUBSCRIPTION',
] as const;

const EngagementSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(200),
  engagementTypeId: z.string().uuid().nullable().optional(),
  defaultFeeStructure: z.enum(FEE_STRUCTURES),
  defaultFeeAmountCents: z.number().int().nonnegative().nullable().optional(),
  defaultBudgetHours: z.number().nonnegative().nullable().optional(),
  inScopeWorkCodeIds: z.array(z.string().uuid()).optional(),
  defaultLetterTemplateId: z.string().uuid().nullable().optional(),
  // 0054 — engagements created from this template inherit this code.
  defaultRateCodeId: z.string().uuid().nullable().optional(),
  customFieldsSchema: z.record(z.string(), z.unknown()).optional(),
});

const LetterSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(200),
  engagementTypeId: z.string().uuid().nullable().optional(),
  bodyHtml: z.string().min(1),
});

const ClientTemplateSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(200),
  clientType: z.enum(['INDIVIDUAL', 'BUSINESS']),
  defaultsJson: z.record(z.string(), z.unknown()).optional(),
  defaultEngagementTemplateIds: z.array(z.string().uuid()).optional(),
});

// Mine {{placeholder}} markers from a body for the variable picker.
function extractVariables(text: string): string[] {
  const re = /{{\s*([a-zA-Z0-9_.]+)\s*}}/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) seen.add(m[1]!);
  return Array.from(seen).sort();
}

export function createTemplateRouter(deps: TemplateRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // ----- Engagement templates -----
  router.get(
    '/engagement',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(engagementTemplates)
        .where(eq(engagementTemplates.firmId, firmId));
      res.json({ items });
    },
  );

  router.post(
    '/engagement',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = EngagementSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const d = parsed.data;
      const [row] = await deps.db
        .insert(engagementTemplates)
        .values({
          firmId,
          key: d.key,
          name: d.name,
          engagementTypeId: d.engagementTypeId ?? null,
          defaultFeeStructure: d.defaultFeeStructure,
          defaultFeeAmountCents: d.defaultFeeAmountCents ?? null,
          defaultBudgetHours: d.defaultBudgetHours != null ? String(d.defaultBudgetHours) : null,
          inScopeWorkCodeIds: d.inScopeWorkCodeIds ?? [],
          defaultLetterTemplateId: d.defaultLetterTemplateId ?? null,
          defaultRateCodeId: d.defaultRateCodeId ?? null,
          customFieldsSchema: d.customFieldsSchema ?? {},
          isSystem: false,
        })
        .returning({ id: engagementTemplates.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_template',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { key: d.key, name: d.name },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/engagement/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = EngagementSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const d = parsed.data;
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (d.key !== undefined) updates.key = d.key;
      if (d.name !== undefined) updates.name = d.name;
      if (d.engagementTypeId !== undefined) updates.engagementTypeId = d.engagementTypeId;
      if (d.defaultFeeStructure !== undefined) updates.defaultFeeStructure = d.defaultFeeStructure;
      if (d.defaultFeeAmountCents !== undefined)
        updates.defaultFeeAmountCents = d.defaultFeeAmountCents;
      if (d.defaultBudgetHours !== undefined)
        updates.defaultBudgetHours =
          d.defaultBudgetHours != null ? String(d.defaultBudgetHours) : null;
      if (d.inScopeWorkCodeIds !== undefined) updates.inScopeWorkCodeIds = d.inScopeWorkCodeIds;
      if (d.defaultLetterTemplateId !== undefined)
        updates.defaultLetterTemplateId = d.defaultLetterTemplateId;
      if (d.defaultRateCodeId !== undefined) updates.defaultRateCodeId = d.defaultRateCodeId;
      if (d.customFieldsSchema !== undefined) updates.customFieldsSchema = d.customFieldsSchema;
      await deps.db
        .update(engagementTemplates)
        .set(updates)
        .where(
          and(
            eq(engagementTemplates.id, req.params['id']!),
            eq(engagementTemplates.firmId, firmId),
          ),
        );
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.patch(
    '/engagement/:id/archive',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(engagementTemplates)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(
          and(
            eq(engagementTemplates.id, req.params['id']!),
            eq(engagementTemplates.firmId, firmId),
          ),
        );
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'engagement_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.post(
    '/engagement/:id/clone',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [src] = await deps.db
        .select()
        .from(engagementTemplates)
        .where(
          and(
            eq(engagementTemplates.id, req.params['id']!),
            eq(engagementTemplates.firmId, firmId),
          ),
        )
        .limit(1);
      if (!src) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const cloneKey = `${src.key}_copy_${Date.now().toString(36)}`;
      const [row] = await deps.db
        .insert(engagementTemplates)
        .values({
          firmId,
          key: cloneKey,
          name: `${src.name} (copy)`,
          engagementTypeId: src.engagementTypeId,
          defaultFeeStructure: src.defaultFeeStructure,
          defaultFeeAmountCents: src.defaultFeeAmountCents,
          defaultBudgetHours: src.defaultBudgetHours,
          inScopeWorkCodeIds: src.inScopeWorkCodeIds,
          defaultLetterTemplateId: src.defaultLetterTemplateId,
          defaultRateCodeId: src.defaultRateCodeId,
          customFieldsSchema: src.customFieldsSchema,
          isSystem: false,
        })
        .returning({ id: engagementTemplates.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_template',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { clonedFrom: src.id, key: cloneKey },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  // ----- Letter templates -----
  router.get(
    '/letter',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(engagementLetterTemplates)
        .where(eq(engagementLetterTemplates.firmId, firmId));
      res.json({ items });
    },
  );

  router.post(
    '/letter',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = LetterSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const d = parsed.data;
      const [row] = await deps.db
        .insert(engagementLetterTemplates)
        .values({
          firmId,
          key: d.key,
          name: d.name,
          engagementTypeId: d.engagementTypeId ?? null,
          bodyHtml: d.bodyHtml,
          variablesJson: extractVariables(d.bodyHtml),
          isSystem: false,
        })
        .returning({ id: engagementLetterTemplates.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_letter_template',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { key: d.key, name: d.name },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/letter/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = LetterSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const d = parsed.data;
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (d.key !== undefined) updates.key = d.key;
      if (d.name !== undefined) updates.name = d.name;
      if (d.engagementTypeId !== undefined) updates.engagementTypeId = d.engagementTypeId;
      if (d.bodyHtml !== undefined) {
        updates.bodyHtml = d.bodyHtml;
        updates.variablesJson = extractVariables(d.bodyHtml);
      }
      await deps.db
        .update(engagementLetterTemplates)
        .set(updates)
        .where(
          and(
            eq(engagementLetterTemplates.id, req.params['id']!),
            eq(engagementLetterTemplates.firmId, firmId),
          ),
        );
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_letter_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.patch(
    '/letter/:id/archive',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(engagementLetterTemplates)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(
          and(
            eq(engagementLetterTemplates.id, req.params['id']!),
            eq(engagementLetterTemplates.firmId, firmId),
          ),
        );
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'engagement_letter_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // ----- Client templates -----
  router.get(
    '/client',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(clientTemplates)
        .where(eq(clientTemplates.firmId, firmId));
      res.json({ items });
    },
  );

  router.post(
    '/client',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = ClientTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const d = parsed.data;
      const [row] = await deps.db
        .insert(clientTemplates)
        .values({
          firmId,
          key: d.key,
          name: d.name,
          clientType: d.clientType,
          defaultsJson: d.defaultsJson ?? {},
          defaultEngagementTemplateIds: d.defaultEngagementTemplateIds ?? [],
          isSystem: false,
        })
        .returning({ id: clientTemplates.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_template',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { key: d.key, name: d.name },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/client/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = ClientTemplateSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const d = parsed.data;
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (d.key !== undefined) updates.key = d.key;
      if (d.name !== undefined) updates.name = d.name;
      if (d.clientType !== undefined) updates.clientType = d.clientType;
      if (d.defaultsJson !== undefined) updates.defaultsJson = d.defaultsJson;
      if (d.defaultEngagementTemplateIds !== undefined)
        updates.defaultEngagementTemplateIds = d.defaultEngagementTemplateIds;
      await deps.db
        .update(clientTemplates)
        .set(updates)
        .where(and(eq(clientTemplates.id, req.params['id']!), eq(clientTemplates.firmId, firmId)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.patch(
    '/client/:id/archive',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(clientTemplates)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(and(eq(clientTemplates.id, req.params['id']!), eq(clientTemplates.firmId, firmId)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_template',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
