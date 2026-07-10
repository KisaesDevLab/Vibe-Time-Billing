// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Firm-editable catalog of manually-recorded payment method types.
// Backs Admin → Catalog → Payment methods and is consumed by the
// Receive Payment form to populate its method dropdown.
//
// System rows (is_system=true) can be renamed and deactivated but
// cannot be deleted — DELETE on a system row returns 409. Existing
// payment.payment_method values are stored as text with no FK so any
// catalog edit leaves history intact.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { paymentMethodTypes } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { pgErrorCode } from '../db-error';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface PaymentMethodTypeDeps extends RbacDeps {
  db: Database | null;
}

// UPPER_SNAKE key (CHECK, CASH, ACH_MANUAL, OTHER, WIRE, ZELLE, …).
// Matches the legacy hard-coded API values + the DB CHECK constraint
// added in migration 0089, so existing payment.payment_method strings
// keep resolving against the catalog without a backfill.
const KEY_RE = /^[A-Z][A-Z0-9_]{0,62}[A-Z0-9]$/;

const CreateSchema = z.object({
  key: z.string().regex(KEY_RE, 'key must be lower_snake_case'),
  label: z.string().min(1).max(120),
  active: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
});

const UpdateSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
});

export function createPaymentMethodTypeRouter(deps: PaymentMethodTypeDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'taxonomy:read'), async (req: Request, res: Response) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select()
      .from(paymentMethodTypes)
      .where(eq(paymentMethodTypes.firmId, firmId))
      .orderBy(asc(paymentMethodTypes.displayOrder), asc(paymentMethodTypes.label));
    res.json({ items });
  });

  router.post(
    '/',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const d = parsed.data;
      try {
        const [row] = await deps.db
          .insert(paymentMethodTypes)
          .values({
            firmId: session.firmId,
            key: d.key,
            label: d.label,
            active: d.active ?? true,
            displayOrder: d.displayOrder ?? 100,
            isSystem: false,
          })
          .returning({ id: paymentMethodTypes.id });
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'payment_method_type',
          entityId: row?.id,
          actorAppUserId: session.appUserId,
          after: d,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.status(201).json({ id: row?.id });
      } catch (err) {
        if (pgErrorCode(err) === '23505') {
          res.status(409).json({ error: 'duplicate_key' });
          return;
        }
        logger.error({ err }, 'payment_method_type insert failed');
        res.status(500).json({ error: 'insert_failed' });
      }
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.label !== undefined) updates['label'] = parsed.data.label;
      if (parsed.data.active !== undefined) updates['active'] = parsed.data.active;
      if (parsed.data.displayOrder !== undefined) {
        updates['displayOrder'] = parsed.data.displayOrder;
      }
      const result = await deps.db
        .update(paymentMethodTypes)
        .set(updates)
        .where(
          and(
            eq(paymentMethodTypes.id, req.params['id']!),
            eq(paymentMethodTypes.firmId, session.firmId),
          ),
        )
        .returning({ id: paymentMethodTypes.id });
      if (result.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'payment_method_type',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: parsed.data,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({ id: paymentMethodTypes.id, isSystem: paymentMethodTypes.isSystem })
        .from(paymentMethodTypes)
        .where(
          and(
            eq(paymentMethodTypes.id, req.params['id']!),
            eq(paymentMethodTypes.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.isSystem) {
        // Don't let the operator nuke a built-in by mistake — the only
        // safe action on a built-in is rename + deactivate.
        res.status(409).json({
          error: 'system_row_undeletable',
          hint: 'Deactivate it instead — system rows cannot be deleted.',
        });
        return;
      }
      await deps.db.delete(paymentMethodTypes).where(eq(paymentMethodTypes.id, row.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'payment_method_type',
        entityId: row.id,
        actorAppUserId: session.appUserId,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}
