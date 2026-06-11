// SPDX-License-Identifier: Elastic-2.0
//
// Required-field rules (Phase 9 #11). Per-firm rules describing which
// fields are required for a time-entry under certain conditions
// (engagement type, work code, etc.). The matching logic lives in
// @vibe/core; this surface is CRUD for admin UIs.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { requiredFieldRules } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';

export interface RequiredFieldRulesDeps extends RbacDeps {
  db: Database | null;
}

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  conditionsJson: z.record(z.unknown()),
  requiredFields: z.array(z.string().max(60)),
});

export function createRequiredFieldRulesRouter(deps: RequiredFieldRulesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get(
    '/',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(requiredFieldRules)
        .where(eq(requiredFieldRules.firmId, session.firmId));
      res.json({ items });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .insert(requiredFieldRules)
        .values({
          firmId: session.firmId,
          name: parsed.data.name,
          conditionsJson: parsed.data.conditionsJson,
          requiredFields: parsed.data.requiredFields,
        })
        .returning({ id: requiredFieldRules.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as Partial<z.infer<typeof CreateSchema>> & { status?: unknown };
      const patch: Record<string, unknown> = {};
      if (typeof body.name === 'string') patch['name'] = body.name.slice(0, 200);
      if (body.conditionsJson != null) patch['conditionsJson'] = body.conditionsJson;
      if (Array.isArray(body.requiredFields)) patch['requiredFields'] = body.requiredFields;
      if (body.status === 'ACTIVE' || body.status === 'INACTIVE' || body.status === 'ARCHIVED') {
        patch['status'] = body.status;
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db
        .update(requiredFieldRules)
        .set(patch)
        .where(
          and(
            eq(requiredFieldRules.id, req.params['id']!),
            eq(requiredFieldRules.firmId, session.firmId),
          ),
        );
      res.json({ ok: true });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .delete(requiredFieldRules)
        .where(
          and(
            eq(requiredFieldRules.id, req.params['id']!),
            eq(requiredFieldRules.firmId, session.firmId),
          ),
        );
      res.json({ ok: true });
    },
  );

  return router;
}
